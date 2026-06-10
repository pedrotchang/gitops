namespace := "cka-labs"
kubevirt_version := "v1.8.3"
cdi_version      := "v1.65.0"

kubevirt_operator_url := "https://github.com/kubevirt/kubevirt/releases/download/" + kubevirt_version + "/kubevirt-operator.yaml"
cdi_operator_url      := "https://github.com/kubevirt/containerized-data-importer/releases/download/" + cdi_version + "/cdi-operator.yaml"

fetch-manifests:
    curl -L {{kubevirt_operator_url}} -o infrastructure/controllers/base/kubevirt/kubevirt-operator.yaml
    curl -L {{cdi_operator_url}}      -o infrastructure/controllers/base/cdi/cdi-operator.yaml
    @echo "Done. Uncomment operator lines in:"
    @echo "  infrastructure/controllers/base/kubevirt/kustomization.yaml"
    @echo "  infrastructure/controllers/base/cdi/kustomization.yaml"
    @echo "Then commit and push."

lab-up:
    virtctl start cka-cp       -n {{namespace}}
    virtctl start cka-worker-1 -n {{namespace}}
    virtctl start cka-worker-2 -n {{namespace}}

lab-down:
    virtctl stop cka-cp       -n {{namespace}}
    virtctl stop cka-worker-1 -n {{namespace}}
    virtctl stop cka-worker-2 -n {{namespace}}

ssh-cp:
    virtctl ssh ubuntu@vm/cka-cp -n {{namespace}}

ssh-w1:
    virtctl ssh ubuntu@vm/cka-worker-1 -n {{namespace}}

ssh-w2:
    virtctl ssh ubuntu@vm/cka-worker-2 -n {{namespace}}

lab-status:
    kubectl get vm,vmi,dv -n {{namespace}}

cluster-setup:
    bash scripts/cluster-setup.sh
