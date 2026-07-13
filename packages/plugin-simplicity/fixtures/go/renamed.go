package fixtures

import (
	"errors"
	"io/fs"
)

// A renamed match: only the function and its parameter are renamed. `errors.Is` and
// `fs.ErrNotExist` are names it refers to, so they stay, and the alpha fingerprint
// still matches isMissing.
func isAbsent(failure error) bool {
	return errors.Is(failure, fs.ErrNotExist)
}
