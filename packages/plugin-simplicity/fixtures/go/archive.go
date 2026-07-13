package fixtures

import (
	"errors"
	"io/fs"
	"os"
)

func ReadArchive(path string) []byte {
	bytes, err := os.ReadFile(path)
	if isMissing(err) {
		return nil
	}
	return bytes
}

// An exact match: copied character for character from store.go.
func isMissing(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}
