NAMESPACE := cka-labs
KUBEVIRT_VERSION := v1.8.3
CDI_VERSION      := v1.65.0

KUBEVIRT_OPERATOR_URL := https://github.com/kubevirt/kubevirt/releases/download/$(KUBEVIRT_VERSION)/kubevirt-operator.yaml
CDI_OPERATOR_URL      := https://github.com/kubevirt/containerized-data-importer/releases/download/$(CDI_VERSION)/cdi-operator.yaml

.PHONY: fetch-manifests lab-up lab-down ssh-cp ssh-w1 ssh-w2 lab-status

fetch-manifests:
	curl -L $(KUBEVIRT_OPERATOR_URL) -o infrastructure/controllers/base/kubevirt/kubevirt-operator.yaml
	curl -L $(CDI_OPERATOR_URL)      -o infrastructure/controllers/base/cdi/cdi-operator.yaml
	@echo "Done. Uncomment operator lines in:"
	@echo "  infrastructure/controllers/base/kubevirt/kustomization.yaml"
	@echo "  infrastructure/controllers/base/cdi/kustomization.yaml"
	@echo "Then commit and push."

lab-up:
	virtctl start cka-cp       -n $(NAMESPACE)
	virtctl start cka-worker-1 -n $(NAMESPACE)
	virtctl start cka-worker-2 -n $(NAMESPACE)

lab-down:
	virtctl stop cka-cp       -n $(NAMESPACE)
	virtctl stop cka-worker-1 -n $(NAMESPACE)
	virtctl stop cka-worker-2 -n $(NAMESPACE)

ssh-cp:
	virtctl ssh ubuntu@cka-cp -n $(NAMESPACE)

ssh-w1:
	virtctl ssh ubuntu@cka-worker-1 -n $(NAMESPACE)

ssh-w2:
	virtctl ssh ubuntu@cka-worker-2 -n $(NAMESPACE)

lab-status:
	kubectl get vm,vmi,dv -n $(NAMESPACE)
