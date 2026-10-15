//! Request ids a shared session has accepted recently.
use std::collections::{HashSet, VecDeque};

/// A replayed id is refused; past the limit the oldest ids are forgotten, so a long-running app never
/// runs out of requests (an id that old can no longer match a live turn).
pub(crate) struct RecentIds {
    order: VecDeque<String>,
    seen: HashSet<String>,
    limit: usize,
}
impl RecentIds {
    pub(crate) fn new(limit: usize) -> Self {
        Self { order: VecDeque::new(), seen: HashSet::new(), limit }
    }
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.seen.contains(id)
    }
    pub(crate) fn insert(&mut self, id: String) {
        if self.seen.insert(id.clone()) {
            self.order.push_back(id);
            while self.order.len() > self.limit {
                if let Some(old) = self.order.pop_front() {
                    self.seen.remove(&old);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_replays_and_forgets_only_the_oldest() {
        let mut ids = RecentIds::new(3);
        for id in ["a", "b", "c"] {
            ids.insert(id.into());
        }
        assert!(ids.contains("a"));
        ids.insert("d".into());
        assert!(!ids.contains("a"));
        assert!(ids.contains("b") && ids.contains("c") && ids.contains("d"));
        for i in 0..10_000 {
            ids.insert(format!("r{i}"));
        }
        assert!(ids.contains("r9999"));
    }
}
