import errno


def read_store(path):
    try:
        with open(path) as handle:
            return handle.read()
    except OSError as error:
        if is_missing(error):
            return ""
        raise


# The three copies carry three DIFFERENT docstrings, which is what a copied Python helper
# looks like: the code is carried over and the prose is reworded. A docstring is a string
# statement rather than a comment, so an extractor that does not treat it as documentation
# puts the prose in both fingerprints and none of these three match. Real Python documents its
# helpers, so that would cost the AST approach most of the language.
def is_missing(error):
    """Whether the error means the file is not there."""
    return error.errno == errno.ENOENT
