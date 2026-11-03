package collect

import (
	"io/fs"
	"os"
	"time"
)

type MapReader struct {
	Files map[string][]byte
}

func (m MapReader) ReadFile(name string) ([]byte, error) {
	raw, ok := m.Files[name]
	if !ok {
		return nil, os.ErrNotExist
	}
	return raw, nil
}

func (m MapReader) Stat(name string) (fs.FileInfo, error) {
	if _, ok := m.Files[name]; !ok {
		return nil, os.ErrNotExist
	}
	return fileInfo{name: name}, nil
}

type fileInfo struct{ name string }

func (f fileInfo) Name() string       { return f.name }
func (f fileInfo) Size() int64        { return 0 }
func (f fileInfo) Mode() fs.FileMode  { return 0 }
func (f fileInfo) ModTime() time.Time { return time.Time{} }
func (f fileInfo) IsDir() bool        { return false }
func (f fileInfo) Sys() any           { return nil }
