package containers

import (
	"errors"
	"strings"
	"testing"
)

func TestSkipWarnerLogsOncePerDistinctError(t *testing.T) {
	var w SkipWarner
	denied := errors.New(`dial unix /var/run/docker.sock: connect: permission denied`)

	msg, ok := w.Check(denied)
	if !ok {
		t.Fatal("first error must be logged")
	}
	if !strings.Contains(msg, "docker group") {
		t.Fatalf("permission denied should hint at the docker group, got %q", msg)
	}
	for i := 0; i < 5; i++ {
		if _, ok := w.Check(denied); ok {
			t.Fatal("repeated identical error must not be logged again")
		}
	}

	other := errors.New("dial unix /var/run/docker.sock: connect: no such file or directory")
	if _, ok := w.Check(other); !ok {
		t.Fatal("a different error must be logged")
	}

	// Recovery is logged once, then a recurrence is logged again.
	if msg, ok := w.Check(nil); !ok || !strings.Contains(msg, "resumed") {
		t.Fatalf("recovery should be logged once, got %q %v", msg, ok)
	}
	if _, ok := w.Check(nil); ok {
		t.Fatal("steady success must stay quiet")
	}
	if _, ok := w.Check(denied); !ok {
		t.Fatal("error after recovery must be logged")
	}
}
