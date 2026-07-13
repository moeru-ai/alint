use std::io;

pub fn cache_entry(path: &str) -> Option<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(failure) if is_absent(&failure) => None,
        Err(failure) => panic!("{}", failure),
    }
}

// A renamed match: only the function and its parameter are renamed.
// `io::ErrorKind::NotFound` and `kind()` are names it refers to, so they stay, and the
// alpha fingerprint still matches `is_missing`.
fn is_absent(failure: &io::Error) -> bool {
    failure.kind() == io::ErrorKind::NotFound
}
