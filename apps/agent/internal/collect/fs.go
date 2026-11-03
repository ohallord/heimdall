package collect

import (
	"io/fs"
	"os"
)

// Reader abstracts filesystem reads so collectors can use fixtures in tests.
type Reader interface {
	ReadFile(name string) ([]byte, error)
	Stat(name string) (fs.FileInfo, error)
}

type OSReader struct{}

func (OSReader) ReadFile(name string) ([]byte, error) {
	return os.ReadFile(name)
}

func (OSReader) Stat(name string) (fs.FileInfo, error) {
	return os.Stat(name)
}

// DiskUsage returns capacity for a mount point.
type DiskUsageFunc func(path string) (total, free int64, err error)
