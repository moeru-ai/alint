import errno


# A renamed match: only the function, its parameter and its docstring are rewritten.
# `errno.ENOENT` and the `.errno` attribute are names it refers to, so they stay, and the
# alpha fingerprint still matches is_missing.
def is_absent(failure):
    """Report whether the failure was a missing file."""
    return failure.errno == errno.ENOENT
