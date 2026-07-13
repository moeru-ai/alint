pub struct Entry {
    pub name: String,
    pub size: u64,
}

// The pair `no-duplicated-helper` must not report: one shape, two questions. Rust
// spells a field access with `field_identifier`, so `name` and `size` are never renamed
// away and the two fingerprints stay apart.
pub fn read_name(entry: &Entry) -> String {
    entry.name.clone()
}

pub fn read_size(entry: &Entry) -> u64 {
    entry.size.clone()
}
