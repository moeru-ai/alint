package fixtures

import (
	"errors"
	"io/fs"
	"os"
)

func ReadStore(path string) string {
	text, err := os.ReadFile(path)
	if isMissing(err) {
		return ""
	}
	return string(text)
}

func isMissing(err error) bool {
	return errors.Is(err, fs.ErrNotExist)
}
