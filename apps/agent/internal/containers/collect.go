package containers

import "time"

func Collect(rt Runtime) (Sample, error) {
	if rt == nil {
		return Sample{
			CollectedAt: time.Now().UTC(),
			Runtime:     "none",
			Containers:  []Snapshot{},
		}, nil
	}
	items, err := rt.List()
	if err != nil {
		return Sample{}, err
	}
	MarkRestartLoops(items)
	return Sample{
		CollectedAt: time.Now().UTC(),
		Runtime:     rt.Name(),
		Containers:  items,
	}, nil
}
