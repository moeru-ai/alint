package fixtures

import (
	"encoding/json"
	"fmt"
	"math"
)

// Two helpers that do not earn their existence, and two that do. All four names are
// lowercase, so none of them leaves this package: the instructions tell the judge to
// leave an exported helper alone unless it is plainly gratuitous, and a decision that
// leaned on that exemption would be measuring the exemption instead of the rule.

// Report. `len(entry.Name)` is shorter than `nameLen(entry)` and says as much. It
// reads `len(...)` and not the bare field on purpose: the bare field would make it a
// renamed copy of accessors.go, which is the other rule's job.
func nameLen(entry Entry) int {
	return len(entry.Name)
}

// Report. A pure forward that hides which encoder is used, so the name tells a reader
// less than the body does.
func decode(raw []byte, value any) error {
	return json.Unmarshal(raw, value)
}

// Stays silent. The name is the documentation: `clampRatio(x, 0, 1)` reads at a glance
// and `math.Min(math.Max(x, 0), 1)` has to be worked out.
func clampRatio(value, low, high float64) float64 {
	return math.Min(math.Max(value, low), high)
}

// Stays silent. Nobody reads `size != 0 && size&(size-1) == 0` at a call site and sees "a
// power of two", so the name is doing all of the work, which is why `clampRatio` stays silent
// too. Go has no type guard, so this is the only kind of earner it can offer: a graded case
// needs an answer a reasonable engineer would not argue with, and "the name carries a domain
// meaning" alone is not one.
func isPowerOfTwo(size uint64) bool {
	return size != 0 && size&(size-1) == 0
}

// The consumer, so the judge is told each single-expression helper is called once.
//
// Keep it under ten lines. A function longer than `maxLines` is never indexed, so a
// longer consumer would still have its calls counted but would quietly stop being a helper
// the corpus covers.
func SummarizeEntry(entry Entry, raw []byte) string {
	var value any

	if decode(raw, &value) != nil || !isPowerOfTwo(uint64(entry.Size)) {
		return ""
	}

	return fmt.Sprintf("%s: %v %.2f", entry.Name, value, clampRatio(float64(nameLen(entry)), 0, 1))
}
