package logs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReadNewLinesIncremental(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "auth.log")
	if err := os.WriteFile(path, []byte("line-one\nline-two\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lines, off, err := ReadNewLines(path, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 {
		t.Fatalf("got %d lines", len(lines))
	}
	if lines[0].Text != "line-one" {
		t.Fatalf("first=%q", lines[0].Text)
	}

	if err := os.WriteFile(path, []byte("line-one\nline-two\nline-three\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	more, off2, err := ReadNewLines(path, off, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(more) != 1 || more[0].Text != "line-three" {
		t.Fatalf("incremental=%v off=%d", more, off2)
	}
}

func TestReadNewLinesMissingFile(t *testing.T) {
	lines, off, err := ReadNewLines("/tmp/heimdall-missing-log-xyz", 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 0 || off != 0 {
		t.Fatalf("expected empty, got %v %d", lines, off)
	}
}

func TestReadNewLinesRotation(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	if err := os.WriteFile(path, []byte("aaaaaaaaaa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, off, err := ReadNewLines(path, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	// Truncate/rotate to smaller file
	if err := os.WriteFile(path, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines, _, err := ReadNewLines(path, off, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].Text != "new" {
		t.Fatalf("rotation restart failed: %v", lines)
	}
}
