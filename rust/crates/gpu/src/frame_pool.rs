use std::collections::HashMap;
use std::hash::Hash;

/// Frames a resource may sit unused in a pool before it is released.
pub const MAX_IDLE_FRAMES: u32 = 2;

/// A GPU object that can give its memory back before its last handle is
/// dropped. wgpu's WebGPU backend does nothing when a texture or buffer handle
/// is dropped (`backend/webgpu.rs`, `impl Drop for WebTexture`: "no-op"); the
/// memory then waits for the JavaScript garbage collector to find the small
/// GPUTexture object, which it has no reason to hurry for. `destroy()` frees
/// it once the work already submitted with it is done.
pub trait Release {
    fn release(&self);
}

impl Release for wgpu::Texture {
    fn release(&self) {
        self.destroy();
    }
}

impl Release for wgpu::Buffer {
    fn release(&self) {
        self.destroy();
    }
}

/// GPU resources reused from frame to frame.
///
/// Everything `acquire` hands out stays in use until the next `recycle`, so one
/// frame never gets the same resource twice. The owner calls `recycle` at the
/// start of a frame, after the previous frame's commands were submitted (or
/// dropped); WebGPU runs a later write to a resource after the submitted work
/// that reads it, so handing the resource out again is safe.
///
/// Resources nobody asked for during more than `MAX_IDLE_FRAMES` frames (a size
/// that is no longer used, an effect that was removed) are given to `release`
/// at `recycle`, so the pool holds at most what recent frames needed.
pub struct FramePool<K, R> {
    available: HashMap<K, Vec<(R, u32)>>,
    in_use: Vec<(K, R)>,
    created: usize,
}

impl<K, R> Default for FramePool<K, R> {
    fn default() -> Self {
        Self {
            available: HashMap::new(),
            in_use: Vec::new(),
            created: 0,
        }
    }
}

impl<K: Eq + Hash + Clone, R: Clone> FramePool<K, R> {
    /// A resource for `key`: a recycled one when there is one, else `create()`.
    pub fn acquire(&mut self, key: K, create: impl FnOnce() -> R) -> R {
        let recycled = self
            .available
            .get_mut(&key)
            .and_then(Vec::pop)
            .map(|(resource, _)| resource);
        let resource = match recycled {
            Some(resource) => resource,
            None => {
                self.created += 1;
                create()
            }
        };
        self.in_use.push((key, resource.clone()));
        resource
    }

    /// Starts a new frame: what the last frame used becomes available again.
    pub fn recycle(&mut self, mut release: impl FnMut(R)) {
        for entries in self.available.values_mut() {
            let mut kept = Vec::with_capacity(entries.len());
            for (resource, idle) in entries.drain(..) {
                if idle + 1 > MAX_IDLE_FRAMES {
                    release(resource);
                } else {
                    kept.push((resource, idle + 1));
                }
            }
            *entries = kept;
        }
        self.available.retain(|_, entries| !entries.is_empty());
        for (key, resource) in self.in_use.drain(..) {
            self.available.entry(key).or_default().push((resource, 0));
        }
    }

    /// Resources created since the pool was made.
    pub fn created(&self) -> usize {
        self.created
    }

    pub fn in_use(&self) -> usize {
        self.in_use.len()
    }

    pub fn available(&self) -> usize {
        self.available.values().map(Vec::len).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    #[derive(Clone, Debug, PartialEq)]
    struct Fake(u32);

    fn counter() -> (Rc<RefCell<u32>>, impl FnMut() -> Fake) {
        let next = Rc::new(RefCell::new(0));
        let shared = next.clone();
        (next, move || {
            *shared.borrow_mut() += 1;
            Fake(*shared.borrow())
        })
    }

    #[test]
    fn a_frame_never_gets_the_same_resource_twice() {
        let mut pool: FramePool<(u32, u32), Fake> = FramePool::default();
        let (_, mut create) = counter();
        let a = pool.acquire((8, 8), &mut create);
        let b = pool.acquire((8, 8), &mut create);
        assert_ne!(a, b);
        assert_eq!(pool.created(), 2);
        assert_eq!(pool.in_use(), 2);
    }

    #[test]
    fn the_next_frame_reuses_what_the_last_frame_used() {
        let mut pool: FramePool<(u32, u32), Fake> = FramePool::default();
        let (_, mut create) = counter();
        let first: Vec<Fake> = (0..2).map(|_| pool.acquire((8, 8), &mut create)).collect();
        pool.recycle(|_| panic!("nothing is idle yet"));
        let second: Vec<Fake> = (0..2).map(|_| pool.acquire((8, 8), &mut create)).collect();
        assert_eq!(pool.created(), 2);
        let mut sorted = second.clone();
        sorted.sort_by_key(|fake| fake.0);
        assert_eq!(sorted, first);
    }

    #[test]
    fn six_hundred_frames_of_two_passes_create_two_resources() {
        let mut pool: FramePool<(u32, u32), Fake> = FramePool::default();
        let (_, mut create) = counter();
        for _ in 0..600 {
            pool.recycle(|_| panic!("used every frame, never idle"));
            pool.acquire((1080, 1920), &mut create);
            pool.acquire((1080, 1920), &mut create);
        }
        assert_eq!(pool.created(), 2);
    }

    #[test]
    fn sizes_are_kept_apart() {
        let mut pool: FramePool<(u32, u32), Fake> = FramePool::default();
        let (_, mut create) = counter();
        pool.acquire((8, 8), &mut create);
        pool.recycle(|_| {});
        pool.acquire((16, 16), &mut create);
        assert_eq!(pool.created(), 2);
    }

    #[test]
    fn an_unused_resource_is_released_after_two_idle_frames() {
        let mut pool: FramePool<(u32, u32), Fake> = FramePool::default();
        let (_, mut create) = counter();
        let old = pool.acquire((8, 8), &mut create);
        let mut released = Vec::new();
        for _ in 0..MAX_IDLE_FRAMES + 1 {
            pool.recycle(|resource| released.push(resource));
        }
        assert!(
            released.is_empty(),
            "released before it was idle long enough"
        );
        assert_eq!(pool.available(), 1);
        pool.recycle(|resource| released.push(resource));
        assert_eq!(released, vec![old]);
        assert_eq!(pool.available(), 0);
    }

    #[test]
    fn a_resource_in_use_again_is_not_idle() {
        let mut pool: FramePool<(u32, u32), Fake> = FramePool::default();
        let (_, mut create) = counter();
        pool.acquire((8, 8), &mut create);
        for _ in 0..10 {
            pool.recycle(|_| panic!("used every other frame at most two frames apart"));
            pool.recycle(|_| panic!("used every other frame at most two frames apart"));
            pool.acquire((8, 8), &mut create);
        }
        assert_eq!(pool.created(), 1);
    }
}
