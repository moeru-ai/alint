package fixtures

type Entry struct {
	Name string
	Size int64
}

func ReadName(entry Entry) string {
	return entry.Name
}

func ReadSize(entry Entry) int64 {
	return entry.Size
}
