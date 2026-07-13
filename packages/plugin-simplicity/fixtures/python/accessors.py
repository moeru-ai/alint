# The pair `no-duplicated-helper` must not report: one shape, two questions.
#
# This is why the Python query needs an `@anchor` capture. Every other grammar 
# spells a property access with its own node type, so leaving that type out of 
# the renameable set is enough. Python spells `entry.name` with a plain `identifier`, 
# the same node type as the parameter, so without an anchor a parameter named `name` 
# would drag the attribute into the placeholder with it and these two would collapse 
# into one fingerprint.
def read_name(entry):
    return entry.name


def read_size(entry):
    return entry.size
