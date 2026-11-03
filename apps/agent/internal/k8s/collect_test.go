package k8s

import (
	"context"
	"testing"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes/fake"
)

func resourceMustParse(s string) resource.Quantity {
	return resource.MustParse(s)
}

func TestCollectWithFakeClientset(t *testing.T) {
	replicas := int32(2)
	client := fake.NewSimpleClientset(
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "node-a"},
			Status: corev1.NodeStatus{
				Conditions: []corev1.NodeCondition{{
					Type:   corev1.NodeReady,
					Status: corev1.ConditionTrue,
				}},
			},
		},
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "node-b"},
			Status: corev1.NodeStatus{
				Conditions: []corev1.NodeCondition{{
					Type:    corev1.NodeReady,
					Status:  corev1.ConditionFalse,
					Reason:  "KubeletNotReady",
					Message: "not ready",
				}},
			},
		},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:              "pending-pod",
				Namespace:         "default",
				CreationTimestamp: metav1.Now(),
			},
			Spec: corev1.PodSpec{
				NodeName: "node-a",
				Containers: []corev1.Container{{
					Name:  "app",
					Image: "busybox:1",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resourceMustParse("100m"),
							corev1.ResourceMemory: resourceMustParse("64Mi"),
						},
						Limits: corev1.ResourceList{
							corev1.ResourceCPU:    resourceMustParse("200m"),
							corev1.ResourceMemory: resourceMustParse("128Mi"),
						},
					},
				}},
			},
			Status: corev1.PodStatus{
				Phase: corev1.PodPending,
				Conditions: []corev1.PodCondition{{
					Type:   corev1.PodScheduled,
					Status: corev1.ConditionFalse,
					Reason: "Unschedulable",
				}},
			},
		},
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "crash-pod", Namespace: "default"},
			Status: corev1.PodStatus{
				Phase: corev1.PodRunning,
				ContainerStatuses: []corev1.ContainerStatus{{
					Name:         "main",
					Image:        "app:bad",
					RestartCount: 5,
					State: corev1.ContainerState{
						Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"},
					},
				}},
			},
		},
		&corev1.Event{
			ObjectMeta: metav1.ObjectMeta{Name: "pending-pod.1", Namespace: "default"},
			InvolvedObject: corev1.ObjectReference{
				Kind:      "Pod",
				Namespace: "default",
				Name:      "pending-pod",
			},
			Type:    "Warning",
			Reason:  "FailedScheduling",
			Message: "0/1 nodes available",
			Count:   3,
		},
		&appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Name: "api", Namespace: "default"},
			Spec:       appsv1.DeploymentSpec{Replicas: &replicas},
			Status:     appsv1.DeploymentStatus{ReadyReplicas: 1, AvailableReplicas: 1},
		},
		&appsv1.Deployment{
			ObjectMeta: metav1.ObjectMeta{Name: "ok", Namespace: "default"},
			Spec:       appsv1.DeploymentSpec{Replicas: &replicas},
			Status:     appsv1.DeploymentStatus{ReadyReplicas: 2, AvailableReplicas: 2},
		},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "default"}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "kube-system"}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "prod"}},
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"},
			Spec: corev1.ServiceSpec{
				Type: corev1.ServiceTypeNodePort,
				Ports: []corev1.ServicePort{{
					Port: 80, NodePort: 30080, TargetPort: intstr.FromInt(80),
				}},
			},
		},
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "internal", Namespace: "default"},
			Spec:       corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP},
		},
		&corev1.Service{
			ObjectMeta: metav1.ObjectMeta{Name: "edge", Namespace: "prod"},
			Spec: corev1.ServiceSpec{
				Type:        corev1.ServiceTypeLoadBalancer,
				ExternalIPs: []string{"203.0.113.10"},
			},
			Status: corev1.ServiceStatus{
				LoadBalancer: corev1.LoadBalancerStatus{
					Ingress: []corev1.LoadBalancerIngress{{Hostname: "edge.example"}},
				},
			},
		},
		&networkingv1.NetworkPolicy{
			ObjectMeta: metav1.ObjectMeta{Name: "deny-all", Namespace: "prod"},
		},
	)

	reader := &ClientsetReader{Client: client}
	sample, err := Collect(Options{Reader: reader, ClusterID: "cluster-a", Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if !sample.APIServerReachable {
		t.Fatalf("expected reachable: %+v", sample)
	}
	if sample.ClusterID != "cluster-a" {
		t.Fatalf("cluster=%s", sample.ClusterID)
	}
	if sample.NodesTotal != 2 || sample.NodesReady != 1 || len(sample.NodesNotReady) != 1 {
		t.Fatalf("nodes=%+v", sample)
	}
	if sample.PodsPending != 1 || sample.PodsCrashLoop != 1 {
		t.Fatalf("pods=%+v", sample)
	}
	if sample.PodsTotal != 2 || len(sample.Pods) != 2 {
		t.Fatalf("pod list total=%d len=%d %+v", sample.PodsTotal, len(sample.Pods), sample.Pods)
	}
	var sawPending, sawCrash bool
	for _, p := range sample.Pods {
		if p.Name == "pending-pod" {
			sawPending = true
			if p.Healthy || p.Phase != "Pending" {
				t.Fatalf("pending pod=%+v", p)
			}
			if p.NodeName != "node-a" {
				t.Fatalf("pending node=%s", p.NodeName)
			}
			if len(p.Conditions) == 0 || p.Conditions[0].Reason != "Unschedulable" {
				t.Fatalf("pending conditions=%+v", p.Conditions)
			}
			if p.Resources == nil || p.Resources.CPURequest == "" {
				t.Fatalf("pending resources=%+v", p.Resources)
			}
			if len(p.Events) == 0 || p.Events[0].Reason != "FailedScheduling" {
				t.Fatalf("pending events=%+v", p.Events)
			}
		}
		if p.Name == "crash-pod" {
			sawCrash = true
			if p.Healthy || p.Reason != "CrashLoopBackOff" {
				t.Fatalf("crash pod=%+v", p)
			}
			if len(p.Containers) != 1 || p.Containers[0].Image != "app:bad" {
				t.Fatalf("crash containers=%+v", p.Containers)
			}
		}
	}
	if !sawPending || !sawCrash {
		t.Fatalf("expected pending+crash in list: %+v", sample.Pods)
	}
	if sample.DeploymentsTotal != 2 || sample.DeploymentsUnhealthy != 1 {
		t.Fatalf("deps=%+v", sample)
	}
	if len(sample.ExposedServices) != 2 {
		t.Fatalf("exposed=%+v", sample.ExposedServices)
	}
	var sawNodePort, sawLB bool
	for _, s := range sample.ExposedServices {
		if s.Name == "web" && s.Type == "NodePort" && len(s.NodePorts) == 1 && s.NodePorts[0] == 30080 {
			sawNodePort = true
		}
		if s.Name == "edge" && s.Type == "LoadBalancer" {
			sawLB = true
		}
	}
	if !sawNodePort || !sawLB {
		t.Fatalf("expected NodePort+LB exposure: %+v", sample.ExposedServices)
	}
	if sample.NetworkPolicy == nil {
		t.Fatal("expected networkPolicy summary")
	}
	if sample.NetworkPolicy.NamespacesTotal != 3 ||
		sample.NetworkPolicy.NamespacesWithPolicy != 1 ||
		sample.NetworkPolicy.NamespacesWithoutPolicy != 2 {
		t.Fatalf("networkPolicy=%+v", sample.NetworkPolicy)
	}
}

func TestCollectNilReader(t *testing.T) {
	sample, err := Collect(Options{ClusterID: "default"})
	if err != nil {
		t.Fatal(err)
	}
	if sample.APIServerReachable {
		t.Fatal("expected unreachable without reader")
	}
}

func TestPingLatency(t *testing.T) {
	reader := &ClientsetReader{Client: fake.NewSimpleClientset()}
	latency, err := reader.Ping(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if latency < 0 {
		t.Fatalf("latency=%v", latency)
	}
}
