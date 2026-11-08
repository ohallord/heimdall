# Fresh test host via LXD on homelab

Used for installer converges (Phase 31: `curl <hub>/install.sh | sudo bash`). homelab has no `/dev/kvm`, so use an LXD **system container** (full systemd), not a VM.

## Setup (once, needs sudo)
```bash
sudo snap install lxd && sudo lxd init --auto     # user dan is already in group lxd
lxc launch ubuntu:24.04 p31-host                    # lxc lives in /snap/bin (add to PATH in non-interactive ssh)
```

## Symptom: container has an IP but no network
`apt-get update` times out and `curl https://<hub>` returns `000`. Cause: Docker/k3s set `iptables -P FORWARD DROP`, which drops `lxdbr0` traffic. Fix (not persistent across reboot):
```bash
sudo iptables -I DOCKER-USER -i lxdbr0 -j ACCEPT
sudo iptables -I DOCKER-USER -o lxdbr0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

## Install without putting the token in chat or argv
1. Settings → Agents → **+ Add a server**; on media: `umask 077; read -rs t; printf %s "$t" > ~/p31/token`
2. `lxc file push --mode 0600 ~/p31/token p31-host/root/hdt-token`
3. `lxc exec p31-host -- bash -c 'curl -fsSL https://<hub>/install.sh | TOKEN_FILE=/root/hdt-token bash'`
4. `shred -u` the token on both sides.

Gotcha: `lxc exec` reads stdin. Inside a script piped through `ssh media 'bash -s'`, add `</dev/null` to every `lxc exec`, or it swallows the rest of the script.

## Teardown
`lxc delete -f p31-host`. The host stays in Fleet → Servers until you revoke it there.
