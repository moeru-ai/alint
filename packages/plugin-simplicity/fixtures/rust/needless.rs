use std::io;

pub struct Entry {
    pub name: String,
    pub size: u64,
}

// The page an entry is written into. Crossing it costs a second write, which is the
// rule `fits_in_page` is named after.
const PAGE_BYTES: u64 = 4096;

// Two helpers that do not earn their existence, and two that do. None of the four
// carries a `pub`, so none of them leaves this module: the instructions tell the judge
// to leave an exported helper alone unless it is plainly gratuitous, and a decision that
// leaned on that exemption would be measuring the exemption instead of the rule.

// Report. `entry.name.len()` is shorter than `name_len(entry)` and says as much. It
// calls `.len()` and does not return the bare field on purpose: the bare field would
// make it a renamed copy of `accessors.rs`, which is the other rule's job.
fn name_len(entry: &Entry) -> usize {
    entry.name.len()
}

// Report. A pure forward that hides which module does the reading, so the name tells a
// reader less than the body does.
fn read_bytes(path: &str) -> io::Result<Vec<u8>> {
    std::fs::read(path)
}

// Stays silent. The name is the documentation: `clamp_ratio(x, 0.0, 1.0)` reads at a
// glance and `x.max(0.0).min(1.0)` has to be worked out.
fn clamp_ratio(value: f64, low: f64, high: f64) -> f64 {
    value.max(low).min(high)
}

// Stays silent, and this is the one a rule gets wrong. Rust has no type guard, so the
// earner here is a predicate whose name states an invariant the arithmetic does not:
// "fits in a page" is a rule someone looked up once, `offset + size <= 4096` is
// arithmetic. `saturating_add` is why it is still right at the top of the range, and it
// is precisely the part a caller inlining this would drop.
fn fits_in_page(offset: u64, size: u64) -> bool {
    offset.saturating_add(size) <= PAGE_BYTES
}

// The consumer, so the judge is told each single-expression helper is called once.
//
// `ratio` is bound rather than written straight into the `format!`. A macro's arguments
// are a token tree rather than expressions, so a call made inside `format!` is not
// a `call_expression` and the extractor cannot see it. Written the shorter way, `clamp_ratio`
// and `name_len` would reach the judge as helpers nothing calls, which is a different
// question from the one this file asks.
pub fn summarize_entry(entry: &Entry, path: &str) -> String {
    let bytes = read_bytes(path).unwrap_or_default();
    let ratio = clamp_ratio(name_len(entry) as f64, 0.0, 1.0);

    if !fits_in_page(entry.size, bytes.len() as u64) {
        return String::new();
    }

    format!("{}: {:.2}", entry.name, ratio)
}
