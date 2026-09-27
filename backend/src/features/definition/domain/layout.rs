//! Canvas coordinates for steps arriving from a definition (Rails `Layout`):
//! roots stack in the first column; a step lands right of its rightmost
//! placed upstream, dropping by one row while the slot is taken.

use std::collections::{HashMap, HashSet};

use crate::shared::dag::Dag;

pub const ROOT_X: i32 = 120;
pub const ROOT_Y: i32 = 120;
pub const CARD_SPACING_X: i32 = 320;
pub const CARD_SPACING_Y: i32 = 220;
pub const MAX_X: i32 = 4000;
pub const MAX_Y: i32 = 3000;

/// `existing`: (name, x, y). `edges`: (source name, destination name).
/// Returns positions for the new steps, keyed by name.
pub fn positions(
    new_step_names: &[String],
    existing: &[(String, i32, i32)],
    edges: &[(String, String)],
) -> HashMap<String, (i32, i32)> {
    let mut coordinates: HashMap<String, (i32, i32)> = HashMap::new();
    let mut occupied: HashSet<(i32, i32)> = HashSet::new();
    for (name, x, y) in existing {
        coordinates.insert(name.clone(), (*x, *y));
        occupied.insert((*x, *y));
    }
    let all_ids: Vec<String> = existing
        .iter()
        .map(|(n, _, _)| n.clone())
        .chain(new_step_names.iter().cloned())
        .collect();
    let dag = Dag::new(all_ids, edges.iter().cloned());

    let mut placed: HashSet<String> = coordinates.keys().cloned().collect();
    let mut pending: Vec<String> = new_step_names.to_vec();
    let mut out = HashMap::new();
    while !pending.is_empty() {
        let ready_all = dag.ready_ids(&placed, &HashSet::new());
        let mut ready: Vec<String> = ready_all
            .into_iter()
            .filter(|n| pending.contains(n))
            .collect();
        // Keep the given order among ready steps.
        ready.sort_by_key(|n| pending.iter().position(|p| p == n));
        if ready.is_empty() {
            ready = vec![pending[0].clone()];
        }
        for name in &ready {
            let (x, mut y) = {
                let ups: Vec<(i32, i32)> = dag
                    .upstreams_of(name)
                    .iter()
                    .filter_map(|u| coordinates.get(u).copied())
                    .collect();
                match ups.iter().max_by_key(|(x, _)| *x) {
                    None => (ROOT_X, ROOT_Y),
                    Some((ux, uy)) => (ux + CARD_SPACING_X, *uy),
                }
            };
            while occupied.contains(&(x, y)) {
                y += CARD_SPACING_Y;
            }
            let slot = (x.clamp(0, MAX_X), y.clamp(0, MAX_Y));
            out.insert(name.clone(), slot);
            coordinates.insert(name.clone(), slot);
            occupied.insert(slot);
            placed.insert(name.clone());
        }
        pending.retain(|p| !ready.contains(p));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: &[&str]) -> Vec<String> {
        n.iter().map(|s| s.to_string()).collect()
    }

    fn edges(e: &[(&str, &str)]) -> Vec<(String, String)> {
        e.iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn stacks_new_roots_in_a_column() {
        let p = positions(&names(&["draft", "review", "publish"]), &[], &[]);
        assert_eq!(p["draft"], (120, 120));
        assert_eq!(p["review"], (120, 340));
        assert_eq!(p["publish"], (120, 560));
    }

    #[test]
    fn places_right_of_its_upstream() {
        let p = positions(
            &names(&["second"]),
            &[("first".into(), 100, 200)],
            &edges(&[("first", "second")]),
        );
        assert_eq!(p["second"], (420, 200));
    }

    #[test]
    fn shifts_a_second_sibling_down() {
        let p = positions(
            &names(&["left", "right"]),
            &[("first".into(), 100, 200)],
            &edges(&[("first", "left"), ("first", "right")]),
        );
        assert_eq!(p["left"], (420, 200));
        assert_eq!(p["right"], (420, 420));
    }

    #[test]
    fn topological_order_for_new_steps() {
        let p = positions(&names(&["up", "down"]), &[], &edges(&[("up", "down")]));
        assert_eq!(p["up"], (120, 120));
        assert_eq!(p["down"], (440, 120));
    }

    #[test]
    fn clamps_to_canvas_bounds() {
        let p = positions(
            &names(&["after_wide", "after_low"]),
            &[("wide".into(), 3900, 2900), ("low".into(), 100, 3200)],
            &edges(&[("wide", "after_wide"), ("low", "after_low")]),
        );
        assert_eq!(p["after_wide"], (4000, 2900));
        assert_eq!(p["after_low"], (420, 3000));
    }
}
