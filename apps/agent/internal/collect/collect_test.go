package collect

import (
	"io/fs"
	"testing"
	"time"
)

func TestParseCPUPercentBetween(t *testing.T) {
	first := []byte("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0 0 0\n")
	second := []byte("cpu  200 0 200 900 0 0 0 0 0 0\ncpu0 100 0 100 450 0 0 0 0 0 0\n")
	a, err := parseCPUTimes(first)
	if err != nil {
		t.Fatal(err)
	}
	b, err := parseCPUTimes(second)
	if err != nil {
		t.Fatal(err)
	}
	pct := cpuPercentBetween(a, b)
	if pct < 66.0 || pct > 67.0 {
		t.Fatalf("unexpected cpu percent: %v", pct)
	}
}

func TestParseMemInfo(t *testing.T) {
	raw := []byte(`MemTotal:       8000000 kB
MemFree:         1000000 kB
MemAvailable:    3000000 kB
Buffers:          200000 kB
Cached:          1500000 kB
`)
	used, total, pct, err := parseMemInfo(raw)
	if err != nil {
		t.Fatal(err)
	}
	if total != 8000000*1024 {
		t.Fatalf("total=%d", total)
	}
	if used != 5000000*1024 {
		t.Fatalf("used=%d", used)
	}
	if pct < 62.0 || pct > 63.0 {
		t.Fatalf("pct=%v", pct)
	}
}

func TestParseLoadAvg(t *testing.T) {
	l1, l5, l15, err := parseLoadAvg([]byte("0.50 0.75 1.00 1/234 9999\n"))
	if err != nil {
		t.Fatal(err)
	}
	if l1 != 0.5 || l5 != 0.75 || l15 != 1.0 {
		t.Fatalf("got %v %v %v", l1, l5, l15)
	}
}

func TestCollectWithFixtures(t *testing.T) {
	baseFiles := map[string][]byte{
		"/proc/meminfo": []byte(`MemTotal:       4000000 kB
MemAvailable:    1000000 kB
MemFree:          500000 kB
Buffers:          100000 kB
Cached:           200000 kB
`),
		"/proc/loadavg": []byte("1.25 0.90 0.70 2/100 1\n"),
		"/proc/mounts": []byte(`/dev/sda1 / ext4 rw,relatime 0 0
/dev/sda2 /boot ext4 rw,relatime 0 0
tmpfs /run tmpfs rw 0 0
`),
	}

	flip := &flipReader{
		reads: 0,
		firstStat: append([]byte(nil), []byte("cpu  100 0 100 800 0 0 0 0 0 0\n")...),
		secondStat: append([]byte(nil), []byte("cpu  200 0 200 900 0 0 0 0 0 0\n")...),
		files: baseFiles,
	}

	sample, err := Collect(Options{
		Reader:        flip,
		CPUSampleWait: time.Millisecond,
		WatchMounts:   []string{"/", "/boot", "/data"},
		DiskUsage: func(path string) (total, free int64, err error) {
			switch path {
			case "/":
				return 1000, 400, nil
			case "/boot":
				return 200, 50, nil
			default:
				return 0, 0, nil
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sample.CPUPercent < 66 || sample.CPUPercent > 67 {
		t.Fatalf("cpu=%v", sample.CPUPercent)
	}
	if sample.MemPercent < 74 || sample.MemPercent > 76 {
		t.Fatalf("mem=%v", sample.MemPercent)
	}
	if sample.Load1 != 1.25 {
		t.Fatalf("load1=%v", sample.Load1)
	}
	if len(sample.Mounts) != 3 {
		t.Fatalf("mounts=%d", len(sample.Mounts))
	}
	if !sample.Mounts[0].Present || !sample.Mounts[1].Present || sample.Mounts[2].Present {
		t.Fatalf("mount presence: %+v", sample.Mounts)
	}
	if len(sample.Disks) != 2 {
		t.Fatalf("disks=%d", len(sample.Disks))
	}
	if sample.Disks[0].UsedPercent != 60 {
		t.Fatalf("root disk pct=%v", sample.Disks[0].UsedPercent)
	}
}

type flipReader struct {
	reads      int
	firstStat  []byte
	secondStat []byte
	files      map[string][]byte
}

func (f *flipReader) ReadFile(name string) ([]byte, error) {
	if name == "/proc/stat" {
		f.reads++
		if f.reads == 1 {
			return f.firstStat, nil
		}
		return f.secondStat, nil
	}
	raw, ok := f.files[name]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return raw, nil
}

func (f *flipReader) Stat(name string) (fs.FileInfo, error) {
	return fileInfo{name: name}, nil
}
