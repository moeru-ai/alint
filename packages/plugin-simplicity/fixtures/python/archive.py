import errno


def read_archive(path):
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError as error:
        if is_missing(error):
            return b""
        raise


# An exact match: the code is copied character for character from store.py, and only the
# docstring was reworded.
def is_missing(error):
    """True when the path does not exist on disk."""
    return error.errno == errno.ENOENT
