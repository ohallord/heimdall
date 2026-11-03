package collect

import (
	"bufio"
	"bytes"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type cpuTimes struct {
	idle  uint64
	total uint64
}

func parseCPUTimes(raw []byte) (cpuTimes, error) {
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return cpuTimes{}, fmt.Errorf("malformed /proc/stat cpu line")
		}
		var total uint64
		var idle uint64
		for i := 1; i < len(fields); i++ {
			v, err := strconv.ParseUint(fields[i], 10, 64)
			if err != nil {
				return cpuTimes{}, err
			}
			total += v
			if i == 4 || i == 5 {
				idle += v
			}
		}
		return cpuTimes{idle: idle, total: total}, nil
	}
	return cpuTimes{}, fmt.Errorf("cpu line not found in /proc/stat")
}

func readCPUTimes(r Reader) (cpuTimes, error) {
	raw, err := r.ReadFile("/proc/stat")
	if err != nil {
		return cpuTimes{}, err
	}
	return parseCPUTimes(raw)
}

func cpuPercentBetween(a, b cpuTimes) float64 {
	idleDelta := float64(b.idle - a.idle)
	totalDelta := float64(b.total - a.total)
	if totalDelta <= 0 {
		return 0
	}
	busy := totalDelta - idleDelta
	if busy < 0 {
		busy = 0
	}
	return (busy / totalDelta) * 100
}

func sampleCPUPercent(r Reader, wait time.Duration) (float64, error) {
	first, err := readCPUTimes(r)
	if err != nil {
		return 0, err
	}
	if wait > 0 {
		time.Sleep(wait)
	}
	second, err := readCPUTimes(r)
	if err != nil {
		return 0, err
	}
	return cpuPercentBetween(first, second), nil
}
