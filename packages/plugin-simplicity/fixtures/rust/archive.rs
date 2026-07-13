use std::io;

pub fn read_archive(path: &str) -> Vec<u8> {
    match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if is_missing(&error) => Vec::new(),
        Err(error) => panic!("{}", error),
    }
}

// An exact match: copied character for character from `store.rs`.
fn is_missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}
