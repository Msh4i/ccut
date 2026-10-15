//! State a wasm export works on, one call at a time, without a `RefCell`
//! borrow held while the call runs.
//!
//! On wasm32 a panic (a wgpu internal `expect`, an `unwrap` in wgpu-hal) is a
//! trap: no destructor runs, so a `RefCell` borrowed across the call stays
//! borrowed for good and every later export call panics with "already
//! borrowed", overwriting `window.__wasmPanic` with that instead of the cause.
//! The slot takes the value out for the call and puts it back after: a call
//! that never returns leaves the slot `Taken`, and later calls get
//! `SlotError::InUse` as a plain error.

use std::cell::RefCell;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SlotError {
    /// Nothing was ever put in (not initialised).
    Empty,
    /// A call took the value and has not put it back: it trapped, or this is a
    /// nested call.
    InUse,
}

enum State<T> {
    Empty,
    Ready(T),
    Taken,
}

pub(crate) struct RuntimeSlot<T> {
    state: RefCell<State<T>>,
}

impl<T> RuntimeSlot<T> {
    pub(crate) const fn new() -> Self {
        Self {
            state: RefCell::new(State::Empty),
        }
    }

    /// Puts a (new) value in; also after a call that never returned.
    pub(crate) fn set(&self, value: T) {
        self.state.replace(State::Ready(value));
    }

    pub(crate) fn with<R>(&self, action: impl FnOnce(&mut T) -> R) -> Result<R, SlotError> {
        // Each `replace` borrows only for itself: nothing is borrowed while
        // `action` runs.
        let mut value = match self.state.replace(State::Taken) {
            State::Ready(value) => value,
            State::Empty => {
                self.state.replace(State::Empty);
                return Err(SlotError::Empty);
            }
            State::Taken => return Err(SlotError::InUse),
        };
        let result = action(&mut value);
        self.state.replace(State::Ready(value));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::panic::{AssertUnwindSafe, catch_unwind};

    use super::{RuntimeSlot, SlotError};

    #[test]
    fn a_call_gets_the_value_and_leaves_it_for_the_next_one() {
        let slot = RuntimeSlot::new();
        slot.set(1_u32);
        assert_eq!(
            slot.with(|value| {
                *value += 1;
                *value
            }),
            Ok(2)
        );
        assert_eq!(slot.with(|value| *value), Ok(2));
    }

    #[test]
    fn an_empty_slot_says_so() {
        let slot: RuntimeSlot<u32> = RuntimeSlot::new();
        assert_eq!(slot.with(|value| *value), Err(SlotError::Empty));
        // and stays empty (not "in use") for the next call
        assert_eq!(slot.with(|value| *value), Err(SlotError::Empty));
        slot.set(3);
        assert_eq!(slot.with(|value| *value), Ok(3));
    }

    /// On wasm32 a panic is a trap: nothing after it runs and no destructor
    /// either. A `RefCell` borrowed across the call then stays borrowed and
    /// every later call panics with "already borrowed". Natively the panic
    /// unwinds, but the slot does not rely on destructors, so it ends in the
    /// same state either way: empty and marked as in use.
    #[test]
    fn a_call_that_panics_leaves_the_slot_in_use_not_borrowed() {
        let slot = RuntimeSlot::new();
        slot.set(7_u32);
        let panicked = catch_unwind(AssertUnwindSafe(|| slot.with(|_| panic!("wgpu error"))));
        assert!(panicked.is_err());
        // a clean error, not a second panic
        assert_eq!(slot.with(|value| *value), Err(SlotError::InUse));
        assert_eq!(slot.with(|value| *value), Err(SlotError::InUse));
        // initialising again makes it usable
        slot.set(9);
        assert_eq!(slot.with(|value| *value), Ok(9));
    }

    #[test]
    fn no_borrow_is_held_while_the_call_runs() {
        let slot = RuntimeSlot::new();
        slot.set(1_u32);
        let nested = slot.with(|_| slot.with(|value| *value));
        assert_eq!(nested, Ok(Err(SlotError::InUse)));
        // and the outer call put the value back
        assert_eq!(slot.with(|value| *value), Ok(1));
    }
}
