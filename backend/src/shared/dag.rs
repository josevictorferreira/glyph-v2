//! Directed-acyclic-graph operations over step ids (Rails `Workflows::Graph`).
//! Works on plain string edges so the same logic serves live workflows and
//! immutable run snapshots. Card position and storage order never influence
//! dependency order.

use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Default)]
pub struct Dag {
    step_ids: Vec<String>,
    downstreams: HashMap<String, Vec<String>>,
    upstreams: HashMap<String, Vec<String>>,
}

impl Dag {
    pub fn new<S, E>(step_ids: S, edges: E) -> Self
    where
        S: IntoIterator,
        S::Item: ToString,
        E: IntoIterator<Item = (String, String)>,
    {
        let mut dag = Self {
            step_ids: step_ids.into_iter().map(|s| s.to_string()).collect(),
            ..Self::default()
        };
        for (source, destination) in edges {
            dag.downstreams
                .entry(source.clone())
                .or_default()
                .push(destination.clone());
            dag.upstreams.entry(destination).or_default().push(source);
        }
        dag
    }

    pub fn step_ids(&self) -> &[String] {
        &self.step_ids
    }

    pub fn upstreams_of(&self, id: &str) -> &[String] {
        self.upstreams.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn downstreams_of(&self, id: &str) -> &[String] {
        self.downstreams.get(id).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Would linking source → destination close a cycle? Exactly when source
    /// is already reachable from destination (or they are the same step).
    pub fn adds_cycle(&self, source: &str, destination: &str) -> bool {
        source == destination || self.reachable_from(destination).contains(source)
    }

    /// Every step reachable from `id`, excluding `id` itself.
    pub fn reachable_from(&self, id: &str) -> HashSet<String> {
        let mut seen = HashSet::new();
        let mut stack = vec![id.to_string()];
        while let Some(current) = stack.pop() {
            if !seen.insert(current.clone()) {
                continue;
            }
            stack.extend(self.downstreams_of(&current).iter().cloned());
        }
        seen.remove(id);
        seen
    }

    pub fn cyclic(&self) -> bool {
        self.step_ids.iter().any(|id| {
            self.downstreams_of(id)
                .iter()
                .any(|n| n == id || self.reachable_from(n).contains(id))
        })
    }

    /// Steps with no upstream dependencies, in step order.
    pub fn root_ids(&self) -> Vec<String> {
        self.step_ids
            .iter()
            .filter(|id| !self.upstreams.contains_key(*id))
            .cloned()
            .collect()
    }

    /// Steps whose upstreams are all in `completed` and which are neither
    /// completed nor in flight, in step order.
    pub fn ready_ids(
        &self,
        completed: &HashSet<String>,
        inflight: &HashSet<String>,
    ) -> Vec<String> {
        self.step_ids
            .iter()
            .filter(|id| !completed.contains(*id) && !inflight.contains(*id))
            .filter(|id| {
                self.upstreams_of(id)
                    .iter()
                    .all(|up| completed.contains(up))
            })
            .cloned()
            .collect()
    }

    /// Transitive dependents — work blocked by a failed step.
    pub fn transitive_downstream(&self, id: &str) -> HashSet<String> {
        self.reachable_from(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dag(edges: &[(&str, &str)], ids: &[&str]) -> Dag {
        Dag::new(
            ids.iter().copied(),
            edges.iter().map(|(a, b)| (a.to_string(), b.to_string())),
        )
    }

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    const ABCD: &[&str] = &["a", "b", "c", "d"];

    #[test]
    fn adds_cycle_detects_self_links() {
        assert!(dag(&[], &["a"]).adds_cycle("a", "a"));
    }

    #[test]
    fn adds_cycle_detects_direct_back_edge() {
        let g = dag(&[("a", "b")], ABCD);
        assert!(g.adds_cycle("b", "a"));
        assert!(!g.adds_cycle("a", "c"));
    }

    #[test]
    fn adds_cycle_detects_transitive_back_edge() {
        let g = dag(&[("a", "b"), ("b", "c")], ABCD);
        assert!(g.adds_cycle("c", "a"));
        assert!(!g.adds_cycle("a", "d"));
    }

    #[test]
    fn cyclic() {
        assert!(!dag(&[("a", "b"), ("a", "c")], ABCD).cyclic());
        assert!(dag(&[("a", "b"), ("b", "a")], ABCD).cyclic());
        assert!(dag(&[("a", "b"), ("b", "c"), ("c", "a")], ABCD).cyclic());
    }

    #[test]
    fn root_ids() {
        let g = dag(&[("a", "b")], ABCD);
        assert_eq!(g.root_ids(), vec!["a", "c", "d"]);
    }

    #[test]
    fn ready_ids_unlock_when_all_upstreams_complete() {
        let g = dag(&[("a", "c"), ("b", "c")], &["a", "b", "c"]);
        assert_eq!(g.ready_ids(&set(&[]), &set(&[])), vec!["a", "b"]);
        assert_eq!(g.ready_ids(&set(&["a"]), &set(&[])), vec!["b"]);
        assert_eq!(g.ready_ids(&set(&["a", "b"]), &set(&[])), vec!["c"]);
        assert!(g.ready_ids(&set(&["a", "b"]), &set(&["c"])).is_empty());
    }

    #[test]
    fn transitive_downstream() {
        let g = dag(&[("a", "b"), ("b", "c"), ("a", "d")], ABCD);
        assert_eq!(g.transitive_downstream("a"), set(&["b", "c", "d"]));
        assert_eq!(g.transitive_downstream("b"), set(&["c"]));
    }
}
