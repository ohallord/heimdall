package collect

import "testing"

// An autofs trigger left behind when the CIFS share under it is down must not
// count as a present mount; otherwise mount_missing can never fire.
func TestSampleMountsAutofsOnlyIsMissing(t *testing.T) {
	r := MapReader{Files: map[string][]byte{
		"/proc/mounts": []byte(`/dev/sda1 / ext4 rw,relatime 0 0
systemd-1 /mnt/Movies autofs rw,relatime,fd=52,pgrp=1,timeout=0,minproto=5,maxproto=5,direct 0 0
systemd-1 /mnt/TvShows autofs rw,relatime,fd=53,pgrp=1,timeout=0,minproto=5,maxproto=5,direct 0 0
//nas/TvShows /mnt/TvShows cifs rw,relatime,vers=3.0 0 0
`),
	}}

	var usageCalls []string
	mounts, disks, err := sampleMounts(r, []string{"/", "/mnt/Movies", "/mnt/TvShows"},
		func(path string) (int64, int64, error) {
			usageCalls = append(usageCalls, path)
			return 1000, 500, nil
		})
	if err != nil {
		t.Fatal(err)
	}

	if !mounts[0].Present {
		t.Fatalf("/ should be present: %+v", mounts[0])
	}
	if mounts[1].Present {
		t.Fatalf("/mnt/Movies is autofs-only and should be missing: %+v", mounts[1])
	}
	if !mounts[2].Present || mounts[2].FSType != "cifs" || mounts[2].Device != "//nas/TvShows" {
		t.Fatalf("/mnt/TvShows should report the cifs mount, not autofs: %+v", mounts[2])
	}
	for _, p := range usageCalls {
		if p == "/mnt/Movies" {
			t.Fatalf("disk usage must not be sampled for a missing mount (statfs would trigger the automount)")
		}
	}
	if len(disks) != 2 {
		t.Fatalf("disks=%d, want 2", len(disks))
	}
}
