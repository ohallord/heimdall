package collect

import (
	"fmt"
	"strconv"
	"strings"
)

func parseLoadAvg(raw []byte) (load1, load5, load15 float64, err error) {
	fields := strings.Fields(string(raw))
	if len(fields) < 3 {
		return 0, 0, 0, fmt.Errorf("malformed /proc/loadavg")
	}
	load1, err = strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0, 0, 0, err
	}
	load5, err = strconv.ParseFloat(fields[1], 64)
	if err != nil {
		return 0, 0, 0, err
	}
	load15, err = strconv.ParseFloat(fields[2], 64)
	if err != nil {
		return 0, 0, 0, err
	}
	return load1, load5, load15, nil
}

func sampleLoad(r Reader) (load1, load5, load15 float64, err error) {
	raw, err := r.ReadFile("/proc/loadavg")
	if err != nil {
		return 0, 0, 0, err
	}
	return parseLoadAvg(raw)
}
