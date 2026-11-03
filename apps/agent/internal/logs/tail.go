package logs

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strings"
)

type Line struct {
	Source string
	Text   string
}

// ReadNewLines reads lines from path after offset bytes and returns the new
// offset (for subsequent polls). Missing files return empty with offset 0.
func ReadNewLines(path string, offset int64, maxLines int) ([]Line, int64, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, offset, fmt.Errorf("path is required")
	}
	if maxLines <= 0 {
		maxLines = 200
	}

	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, nil
		}
		return nil, offset, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, offset, err
	}
	size := info.Size()
	if offset > size {
		// File rotated/truncated — restart from beginning.
		offset = 0
	}
	if offset > 0 {
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return nil, offset, err
		}
	}

	reader := bufio.NewReaderSize(f, 64*1024)
	var lines []Line
	pos := offset
	for len(lines) < maxLines {
		text, err := reader.ReadString('\n')
		if len(text) > 0 {
			n := int64(len(text))
			pos += n
			trimmed := strings.TrimRight(text, "\r\n")
			if strings.TrimSpace(trimmed) != "" {
				lines = append(lines, Line{Source: path, Text: trimmed})
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return lines, pos, err
		}
	}
	return lines, pos, nil
}

// ReadAllLines reads an entire small fixture/file (tests / one-shot collect).
func ReadAllLines(path string) ([]Line, error) {
	lines, _, err := ReadNewLines(path, 0, 100000)
	return lines, err
}
