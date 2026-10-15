use gpu::{FramePool, Release};

/// Output textures (`T`) and uniform buffers (`B`) of the effect passes.
///
/// Until `recycle_frame` is called the first time, every pass creates its own
/// and the caller gets them back as scratch (it may release them once the
/// commands are submitted). From then on they come from frame pools: one frame
/// never shares one, the next frame reuses them.
pub(crate) struct PassResources<T, B> {
    pooled: bool,
    textures: FramePool<(u32, u32), T>,
    uniforms: FramePool<(), B>,
}

impl<T, B> Default for PassResources<T, B> {
    fn default() -> Self {
        Self {
            pooled: false,
            textures: FramePool::default(),
            uniforms: FramePool::default(),
        }
    }
}

/// A uniform buffer for one pass; `pooled` buffers must be written through the
/// queue, new ones were created with their contents.
pub(crate) struct PassUniform<B> {
    pub buffer: B,
    pub pooled: bool,
}

impl<T: Clone + Release, B: Clone + Release> PassResources<T, B> {
    pub fn recycle_frame(&mut self) {
        self.pooled = true;
        self.textures.recycle(|texture| texture.release());
        self.uniforms.recycle(|buffer| buffer.release());
    }

    pub fn texture(
        &mut self,
        size: (u32, u32),
        create: impl FnOnce() -> T,
        scratch: &mut Vec<T>,
    ) -> T {
        if self.pooled {
            return self.textures.acquire(size, create);
        }
        let texture = create();
        scratch.push(texture.clone());
        texture
    }

    /// `create_pooled` makes an empty buffer (pooled mode), `create_filled` one
    /// that already holds the pass's uniforms.
    pub fn uniform(
        &mut self,
        create_pooled: impl FnOnce() -> B,
        create_filled: impl FnOnce() -> B,
        scratch: &mut Vec<B>,
    ) -> PassUniform<B> {
        if self.pooled {
            return PassUniform {
                buffer: self.uniforms.acquire((), create_pooled),
                pooled: true,
            };
        }
        let buffer = create_filled();
        scratch.push(buffer.clone());
        PassUniform {
            buffer,
            pooled: false,
        }
    }

    pub fn created(&self) -> (usize, usize) {
        (self.textures.created(), self.uniforms.created())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    #[derive(Clone, Debug, PartialEq)]
    struct Fake {
        id: u32,
        released: Rc<RefCell<Vec<u32>>>,
    }

    impl Release for Fake {
        fn release(&self) {
            self.released.borrow_mut().push(self.id);
        }
    }

    struct Factory {
        next: Cell<u32>,
        released: Rc<RefCell<Vec<u32>>>,
    }

    impl Factory {
        fn new() -> Self {
            Self {
                next: Cell::new(0),
                released: Rc::new(RefCell::new(Vec::new())),
            }
        }

        fn make(&self) -> Fake {
            self.next.set(self.next.get() + 1);
            Fake {
                id: self.next.get(),
                released: self.released.clone(),
            }
        }
    }

    /// One frame of a two-pass blur: two textures, two uniform buffers.
    fn blur_frame(
        resources: &mut PassResources<Fake, Fake>,
        factory: &Factory,
    ) -> (Vec<Fake>, Vec<Fake>, Vec<bool>) {
        let mut scratch_textures = Vec::new();
        let mut scratch_buffers = Vec::new();
        let mut pooled = Vec::new();
        for _ in 0..2 {
            resources.texture((1080, 1920), || factory.make(), &mut scratch_textures);
            let uniform =
                resources.uniform(|| factory.make(), || factory.make(), &mut scratch_buffers);
            pooled.push(uniform.pooled);
        }
        (scratch_textures, scratch_buffers, pooled)
    }

    #[test]
    fn without_frame_signals_every_pass_creates_its_own_and_hands_it_back() {
        let mut resources = PassResources::default();
        let factory = Factory::new();
        for _ in 0..3 {
            let (textures, buffers, pooled) = blur_frame(&mut resources, &factory);
            assert_eq!(textures.len(), 2);
            assert_eq!(buffers.len(), 2);
            assert_eq!(pooled, vec![false, false]);
        }
        assert_eq!(factory.next.get(), 12);
        assert_eq!(resources.created(), (0, 0));
    }

    #[test]
    fn with_frame_signals_six_hundred_frames_create_two_textures_and_two_buffers() {
        let mut resources = PassResources::default();
        let factory = Factory::new();
        for _ in 0..600 {
            resources.recycle_frame();
            let (textures, buffers, pooled) = blur_frame(&mut resources, &factory);
            assert!(textures.is_empty());
            assert!(buffers.is_empty());
            assert_eq!(pooled, vec![true, true]);
        }
        assert_eq!(resources.created(), (2, 2));
        assert_eq!(factory.next.get(), 4);
        assert!(factory.released.borrow().is_empty());
    }

    #[test]
    fn a_blur_that_stops_frees_its_textures_and_buffers_after_idle_frames() {
        let mut resources = PassResources::default();
        let factory = Factory::new();
        resources.recycle_frame();
        blur_frame(&mut resources, &factory);
        for _ in 0..4 {
            resources.recycle_frame();
        }
        let mut released = factory.released.borrow().clone();
        released.sort();
        assert_eq!(released, vec![1, 2, 3, 4]);
    }
}
