package collect

import (
	"reflect"
	"testing"
)

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
	mounts, disks, err := sampleMounts(r, []string{"/", "/mnt/Movies", "/mnt/TvShows"}, "/",
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

// homelab bare metal: /var and /boot are directories on /, not mounts.
const bareMetalMounts = `sysfs /sys sysfs rw,nosuid 0 0
proc /proc proc rw 0 0
udev /dev devtmpfs rw 0 0
/dev/sde2 / ext4 rw,relatime 0 0
/dev/sde1 /boot/efi vfat rw 0 0
tmpfs /run tmpfs rw 0 0
cgroup2 /sys/fs/cgroup cgroup2 rw 0 0
/dev/mapper/media1-mediavol1 /media1 ext4 rw 0 0
/dev/sdd1 /mnt/Movies\040Disk ext4 rw 0 0
/dev/loop3 /snap/core22/1380 squashfs ro 0 0
overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0
nsfs /run/docker/netns/x nsfs rw 0 0
/dev/sde2 /var/lib/docker/volumes/v/_data ext4 rw 0 0
nas:/export /data nfs4 rw 0 0
`

func usageAll(path string) (int64, int64, error) { return 1000, 250, nil }

func diskPaths(disks []DiskSample) []string {
	out := make([]string, 0, len(disks))
	for _, d := range disks {
		out = append(out, d.MountPoint)
	}
	return out
}

func TestSampleMountsDefaultExpectIsRootOnly(t *testing.T) {
	r := MapReader{Files: map[string][]byte{"/proc/mounts": []byte(bareMetalMounts)}}
	mounts, _, err := sampleMounts(r, DefaultExpectMounts("/"), "/", usageAll)
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Path != "/" || !mounts[0].Present {
		t.Fatalf("default expect should be / only and present, got %+v", mounts)
	}
	for _, m := range mounts {
		if m.Path == "/var" || m.Path == "/boot" {
			t.Fatalf("%s is a directory on /, must not be reported missing: %+v", m.Path, mounts)
		}
	}
}

func TestSampleMountsDiscoversRealFilesystems(t *testing.T) {
	r := MapReader{Files: map[string][]byte{"/proc/mounts": []byte(bareMetalMounts)}}
	_, disks, err := sampleMounts(r, []string{"/"}, "/", usageAll)
	if err != nil {
		t.Fatal(err)
	}
	// Pseudo fs, tmpfs, squashfs snaps, docker overlays and same-device binds are dropped;
	// escaped spaces are decoded.
	want := []string{"/", "/boot/efi", "/media1", "/mnt/Movies Disk", "/data"}
	if got := diskPaths(disks); !reflect.DeepEqual(got, want) {
		t.Fatalf("discovered disks\n got %v\nwant %v", got, want)
	}
	if disks[0].FSType != "ext4" || disks[0].UsedPercent != 75 {
		t.Fatalf("root disk sample: %+v", disks[0])
	}
}

func TestSampleMountsExpectedMissingOnlyForExpectList(t *testing.T) {
	r := MapReader{Files: map[string][]byte{"/proc/mounts": []byte(bareMetalMounts)}}
	mounts, _, err := sampleMounts(r, []string{"/", "/backup"}, "/", usageAll)
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 2 || !mounts[0].Present || mounts[1].Present || mounts[1].Path != "/backup" {
		t.Fatalf("want / present and /backup missing, got %+v", mounts)
	}
}

func TestSampleMountsHostRootScopesDiscovery(t *testing.T) {
	// K8s agent with host / bound at /host (HostToContainer propagation).
	raw := `overlay / overlay rw 0 0
proc /proc proc rw 0 0
/dev/sde2 /etc/hosts ext4 rw 0 0
/dev/sde2 /host ext4 ro 0 0
/dev/sde1 /host/boot/efi vfat ro 0 0
/dev/mapper/media1-mediavol1 /host/media1 ext4 ro 0 0
overlay /host/var/lib/docker/overlay2/abc/merged overlay rw 0 0
tmpfs /host/run tmpfs rw 0 0
`
	r := MapReader{Files: map[string][]byte{"/proc/mounts": []byte(raw)}}
	mounts, disks, err := sampleMounts(r, DefaultExpectMounts("/host"), "/host", usageAll)
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Path != "/host" || !mounts[0].Present {
		t.Fatalf("default expect with host root should be /host, got %+v", mounts)
	}
	want := []string{"/host", "/host/boot/efi", "/host/media1"}
	if got := diskPaths(disks); !reflect.DeepEqual(got, want) {
		t.Fatalf("discovered disks\n got %v\nwant %v", got, want)
	}
}

func TestSampleMountsExpectedOverlayRootKeepsDisk(t *testing.T) {
	// Compose agent without host bind: / is overlay (filtered from discovery) but expected.
	raw := "overlay / overlay rw 0 0\nproc /proc proc rw 0 0\n"
	r := MapReader{Files: map[string][]byte{"/proc/mounts": []byte(raw)}}
	mounts, disks, err := sampleMounts(r, []string{"/"}, "/", usageAll)
	if err != nil {
		t.Fatal(err)
	}
	if !mounts[0].Present {
		t.Fatalf("/ should be present: %+v", mounts)
	}
	if got := diskPaths(disks); !reflect.DeepEqual(got, []string{"/"}) {
		t.Fatalf("expected / to keep its disk sample, got %v", got)
	}
}

func TestSampleMountsCapsDiscovered(t *testing.T) {
	raw := "/dev/root / ext4 rw 0 0\n"
	for i := 0; i < 100; i++ {
		raw += "nas:/e" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + " /n/" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + " nfs rw 0 0\n"
	}
	r := MapReader{Files: map[string][]byte{"/proc/mounts": []byte(raw)}}
	_, disks, err := sampleMounts(r, []string{"/"}, "/", usageAll)
	if err != nil {
		t.Fatal(err)
	}
	if len(disks) != maxDiscoveredMounts {
		t.Fatalf("disks=%d want cap %d", len(disks), maxDiscoveredMounts)
	}
	if disks[0].MountPoint != "/" {
		t.Fatalf("cap must keep the root first, got %s", disks[0].MountPoint)
	}
}
