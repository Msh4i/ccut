use std::collections::HashMap;

use gpu::{Release, wgpu};

/// The pixel size of a texture (what `plan_upload` compares).
pub trait TextureExtent {
    fn extent(&self) -> (u32, u32);
}

impl TextureExtent for wgpu::Texture {
    fn extent(&self) -> (u32, u32) {
        (self.width(), self.height())
    }
}

pub struct StoredTexture<T = wgpu::Texture> {
    texture: T,
    generation: u64,
}

impl<T> StoredTexture<T> {
    fn new(texture: T, generation: u64) -> Self {
        Self {
            texture,
            generation,
        }
    }

    pub fn texture(&self) -> &T {
        &self.texture
    }

    /// Changes at every write to this id (a new texture, or pixels copied into
    /// the stored one); never repeats for the store's lifetime, also not after
    /// the id was removed and stored again.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

/// Uploaded layer textures by id.
///
/// A texture that leaves the store (replaced by a new upload under the same id,
/// or removed) is released at once (`Release`: WebGPU `destroy()`), unless the
/// same texture is still stored: wgpu's WebGPU backend frees nothing when a
/// handle is dropped, so every replaced video-frame upload used to keep its
/// GPU memory until the JavaScript garbage collector ran. Uploads happen
/// between frames, after the previous frame's commands were submitted, and
/// `destroy()` lets submitted work finish first.
pub struct TextureStore<T = wgpu::Texture> {
    textures: HashMap<String, StoredTexture<T>>,
    /// Last generation handed out.
    last_generation: u64,
}

impl<T> Default for TextureStore<T> {
    fn default() -> Self {
        Self {
            textures: HashMap::new(),
            last_generation: 0,
        }
    }
}

impl<T> TextureStore<T> {
    pub fn get(&self, id: &str) -> Option<&StoredTexture<T>> {
        self.textures.get(id)
    }
}

impl<T: TextureExtent> TextureStore<T> {
    /// Size of the texture stored under `id`.
    pub fn extent(&self, id: &str) -> Option<(u32, u32)> {
        self.textures.get(id).map(|stored| stored.texture.extent())
    }
}

impl<T: Release + PartialEq> TextureStore<T> {
    pub fn upsert(&mut self, id: String, texture: T) {
        self.last_generation += 1;
        let stored = StoredTexture::new(texture, self.last_generation);
        if let Some(previous) = self.textures.insert(id, stored) {
            self.release_unless_stored(previous.texture);
        }
    }

    /// Pixels were copied into the texture stored under `id` (an upload that
    /// reused it): a new generation, nothing released. False: no such id.
    pub fn mark_updated(&mut self, id: &str) -> bool {
        let Some(stored) = self.textures.get_mut(id) else {
            return false;
        };
        self.last_generation += 1;
        stored.generation = self.last_generation;
        true
    }

    pub fn remove(&mut self, id: &str) {
        if let Some(previous) = self.textures.remove(id) {
            self.release_unless_stored(previous.texture);
        }
    }

    fn release_unless_stored(&self, texture: T) {
        let still_stored = self
            .textures
            .values()
            .any(|stored| stored.texture == texture);
        if !still_stored {
            texture.release();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// A texture handle: clones share the id, like wgpu handles.
    #[derive(Clone)]
    struct FakeTexture {
        id: u32,
        released: Rc<RefCell<Vec<u32>>>,
    }

    impl PartialEq for FakeTexture {
        fn eq(&self, other: &Self) -> bool {
            self.id == other.id
        }
    }

    impl TextureExtent for FakeTexture {
        fn extent(&self) -> (u32, u32) {
            (self.id, self.id + 1)
        }
    }

    impl Release for FakeTexture {
        fn release(&self) {
            self.released.borrow_mut().push(self.id);
        }
    }

    fn textures() -> (Rc<RefCell<Vec<u32>>>, impl Fn(u32) -> FakeTexture) {
        let released = Rc::new(RefCell::new(Vec::new()));
        let shared = released.clone();
        (released, move |id| FakeTexture {
            id,
            released: shared.clone(),
        })
    }

    #[test]
    fn a_new_upload_releases_the_texture_it_replaces() {
        let (released, texture) = textures();
        let mut store = TextureStore::default();
        store.upsert("video".to_string(), texture(1));
        store.upsert("video".to_string(), texture(2));
        store.upsert("video".to_string(), texture(3));
        assert_eq!(*released.borrow(), vec![1, 2]);
        assert_eq!(
            store.get("video").map(|stored| stored.texture().id),
            Some(3)
        );
    }

    #[test]
    fn storing_the_same_texture_again_keeps_it() {
        let (released, texture) = textures();
        let mut store = TextureStore::default();
        let reused = texture(7);
        store.upsert("video".to_string(), reused.clone());
        store.upsert("video".to_string(), reused);
        assert!(released.borrow().is_empty());
    }

    #[test]
    fn a_texture_still_stored_under_another_id_is_kept() {
        let (released, texture) = textures();
        let mut store = TextureStore::default();
        let shared = texture(4);
        store.upsert("a".to_string(), shared.clone());
        store.upsert("b".to_string(), shared);
        store.remove("a");
        assert!(released.borrow().is_empty());
        store.remove("b");
        assert_eq!(*released.borrow(), vec![4]);
    }

    #[test]
    fn removing_a_texture_releases_it_once() {
        let (released, texture) = textures();
        let mut store = TextureStore::default();
        store.upsert("mask".to_string(), texture(5));
        store.remove("mask");
        store.remove("mask");
        assert_eq!(*released.borrow(), vec![5]);
        assert!(store.get("mask").is_none());
    }

    #[test]
    fn six_hundred_uploads_leave_one_texture_alive() {
        let (released, texture) = textures();
        let mut store = TextureStore::default();
        for id in 0..600 {
            store.upsert("video".to_string(), texture(id));
        }
        assert_eq!(released.borrow().len(), 599);
    }

    fn generation_of(store: &TextureStore<FakeTexture>, id: &str) -> Option<u64> {
        store.get(id).map(|stored| stored.generation())
    }

    #[test]
    fn every_write_to_an_id_gives_it_a_new_generation_and_a_reuse_releases_nothing() {
        let (released, texture) = textures();
        let mut store = TextureStore::default();
        store.upsert("video".to_string(), texture(1));
        let first = generation_of(&store, "video").unwrap();
        assert!(store.mark_updated("video"));
        assert_eq!(generation_of(&store, "video"), Some(first + 1));
        assert!(store.mark_updated("video"));
        assert_eq!(generation_of(&store, "video"), Some(first + 2));
        store.upsert("video".to_string(), texture(2));
        assert_eq!(generation_of(&store, "video"), Some(first + 3));
        // Only the replacement released something; the two reuses did not.
        assert_eq!(*released.borrow(), vec![1]);
    }

    #[test]
    fn marking_an_unknown_id_changes_nothing() {
        let (_released, texture) = textures();
        let mut store = TextureStore::default();
        store.upsert("a".to_string(), texture(1));
        let before = generation_of(&store, "a");
        assert!(!store.mark_updated("missing"));
        assert_eq!(generation_of(&store, "a"), before);
    }

    #[test]
    fn a_generation_is_never_seen_twice_even_after_remove_and_store_again() {
        let (_released, texture) = textures();
        let mut store = TextureStore::default();
        store.upsert("a".to_string(), texture(1));
        let old = generation_of(&store, "a").unwrap();
        store.remove("a");
        store.upsert("a".to_string(), texture(1));
        assert!(generation_of(&store, "a").unwrap() > old);
    }

    #[test]
    fn the_extent_is_the_stored_textures() {
        let (_released, texture) = textures();
        let mut store = TextureStore::default();
        assert_eq!(store.extent("a"), None);
        store.upsert("a".to_string(), texture(6));
        assert_eq!(store.extent("a"), Some((6, 7)));
    }
}
