package containers

import (
	"fmt"
	"strings"
)

// SkipWarner de-duplicates "container collect skipped" warnings: the agent collects every
// interval, so an unreadable socket would otherwise log the same line forever. It reports
// the first occurrence of each distinct error, and one line when collection recovers.
type SkipWarner struct {
	last   string
	failed bool
}

// Check returns the message to log and whether to log it.
func (w *SkipWarner) Check(err error) (string, bool) {
	if err == nil {
		if !w.failed {
			return "", false
		}
		w.failed, w.last = false, ""
		return "container collect resumed", true
	}
	msg := err.Error()
	if w.failed && msg == w.last {
		return "", false
	}
	w.failed, w.last = true, msg
	out := fmt.Sprintf("container collect skipped: %s", msg)
	if strings.Contains(msg, "permission denied") {
		out += " (the agent user cannot read the container socket: add it to the docker group, " +
			"e.g. reinstall with the hub's install.sh, which does this when a docker group exists; " +
			"further identical errors are suppressed)"
	} else {
		out += " (further identical errors are suppressed)"
	}
	return out, true
}
