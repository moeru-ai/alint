import json

from dataclasses import dataclass
from typing import TypeGuard


@dataclass
class Entry:
    name: str
    size: int


# Two helpers that do not earn their existence, and two that do. All four names lead
# with an underscore, so none of them is public: the instructions tell the judge to
# leave an exported helper alone unless it is plainly gratuitous, and a decision that
# leaned on that exemption would be measuring the exemption instead of the rule.
#
# The two that must be reported carry docstrings, because real Python helpers do. A
# docstring is a string statement, so counting it would make the body two statements and
# neither helper would ever reach the judge. Both docstrings say again what the body
# already says, which is what the docstring of a needless helper looks like.


# Report. `len(entry.name)` is shorter than `_name_length(entry)` and says as much. It
# calls `len(...)` and does not return the bare attribute on purpose: the bare attribute
# would make it a renamed copy of accessors.py, which is the other rule's job.
def _name_length(entry: Entry) -> int:
    """Return the length of the entry's name."""
    return len(entry.name)


# Report. A pure forward that hides which parser is used, so the name tells a reader
# less than the body does.
def _parse(text: str) -> object:
    """Parse the text."""
    return json.loads(text)


# Stays silent. The name is the documentation: `_clamp(x, 0, 1)` reads at a glance and
# `min(max(x, 0), 1)` has to be worked out.
def _clamp(value: int, low: int, high: int) -> int:
    return min(max(value, low), high)


# Stays silent, and this is the one a rule gets wrong. It is a `TypeGuard`, and the
# narrowing is the point: no runtime check on the list object itself can narrow a
# `list[object]` to a `list[Entry]`, so inlining the `all(...)` would run the very same
# check and leave every call site still holding a `list[object]`.
def _is_entry_list(values: list[object]) -> TypeGuard[list[Entry]]:
    return all(isinstance(value, Entry) for value in values)


# The consumer, so the judge is told each single-expression helper is called once.
def describe_entry(values: list[object], raw: str) -> str:
    if not _is_entry_list(values):
        return str(_parse(raw))

    entry = values[0]

    return f"{entry.name} ({entry.size}): {_clamp(_name_length(entry), 0, 1024)}"
