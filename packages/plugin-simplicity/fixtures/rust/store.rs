use std::io;

pub fn read_store(path: &str) -> String {
    match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if is_missing(&error) => String::new(),
        Err(error) => panic!("{}", error),
    }
}

fn is_missing(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound
}
