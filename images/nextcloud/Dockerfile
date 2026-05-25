FROM nextcloud:stable@sha256:80241648313b230e3546a8552260c17034a68b59c28271aecbf5317065bd0fd3

ARG USER_OIDC_VERSION=0.3.2

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg curl && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL \
    "https://github.com/nextcloud/user_oidc/releases/download/v${USER_OIDC_VERSION}/user_oidc.tar.gz" \
    | tar -xz -C /var/www/html/custom_apps/
