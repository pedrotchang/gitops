# Exam Dotfiles

Memorize and type from scratch at the start of every exam session.

## ~/.bashrc

```bash
alias k='kubectl'
alias kg='kubectl get'
alias kn='kubectl config set-context --current --namespace'
alias kgp='kubectl get pods'
alias kgs='kubectl get svc'
alias kgn='kubectl get nodes'
alias kd='kubectl describe'
alias kaf='kubectl apply -f'
alias kdel='kubectl delete'
alias ll='ls -lah'

alias d='docker'
alias de='docker exec'

export do='--dry-run=client -o yaml'
export now='--force --grace-period=0'

export ETCDCTL_API=3

source <(kubectl completion bash)
complete -o default -F __start_kubectl k
```

## ~/.vimrc

```vim
set ts=2 sts=2 sw=2
set expandtab
set number ruler
set autoindent
syntax enable
```

## Apply

```bash
source ~/.bashrc
```
