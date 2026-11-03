package collect

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
)

func parseMemInfo(raw []byte) (used, total int64, percent float64, err error) {
	values := map[string]int64{}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if len(fields) == 0 {
			continue
		}
		v, parseErr := strconv.ParseInt(fields[0], 10, 64)
		if parseErr != nil {
			continue
		}
		// /proc/meminfo values are in kB.
		values[key] = v * 1024
	}

	total = values["MemTotal"]
	if total <= 0 {
		return 0, 0, 0, fmt.Errorf("MemTotal missing from /proc/meminfo")
	}
	available := values["MemAvailable"]
	if available == 0 {
		available = values["MemFree"] + values["Buffers"] + values["Cached"]
	}
	used = total - available
	if used < 0 {
		used = 0
	}
	percent = (float64(used) / float64(total)) * 100
	return used, total, percent, nil
}

func sampleMemory(r Reader) (used, total int64, percent float64, err error) {
	raw, err := r.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, 0, err
	}
	return parseMemInfo(raw)
}
