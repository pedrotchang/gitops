kubevirt_version := "v1.8.3"
cdi_version      := "v1.65.0"

kubevirt_operator_url := "https://github.com/kubevirt/kubevirt/releases/download/" + kubevirt_version + "/kubevirt-operator.yaml"
cdi_operator_url      := "https://github.com/kubevirt/containerized-data-importer/releases/download/" + cdi_version + "/cdi-operator.yaml"

# The CKA/CKS lab (VMs, cluster-setup, exercises) lives in its own repo:
# https://forgejo.seyzahl.com/continuous-learning/cka-labs
# This repo only manages the KubeVirt/CDI operators it runs on.

fetch-manifests:
    curl -L {{kubevirt_operator_url}} -o infrastructure/controllers/base/kubevirt/kubevirt-operator.yaml
    curl -L {{cdi_operator_url}}      -o infrastructure/controllers/base/cdi/cdi-operator.yaml
    @echo "Done. Uncomment operator lines in:"
    @echo "  infrastructure/controllers/base/kubevirt/kustomization.yaml"
    @echo "  infrastructure/controllers/base/cdi/kustomization.yaml"
    @echo "Then commit and push."
