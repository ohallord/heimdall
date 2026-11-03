package containers

// MockRuntime is a fixture-backed runtime for unit tests.
type MockRuntime struct {
	RuntimeName string
	Items       []Snapshot
	Err         error
}

func (m *MockRuntime) Name() string {
	if m.RuntimeName == "" {
		return "mock"
	}
	return m.RuntimeName
}

func (m *MockRuntime) List() ([]Snapshot, error) {
	if m.Err != nil {
		return nil, m.Err
	}
	out := append([]Snapshot(nil), m.Items...)
	MarkRestartLoops(out)
	return out, nil
}
