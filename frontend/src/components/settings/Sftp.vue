<template>
    <div class="my-4">
        <p>{{ $t("SFTP access help") }}</p>

        <div v-if="loading" class="text-muted">
            {{ $t("Loading") }}
        </div>
        <div v-else-if="!available" class="alert alert-warning">
            {{ $t("SFTP unavailable") }}
        </div>
        <div v-else>
            <div class="row g-3 mb-4">
                <div class="col-md-6">
                    <label class="form-label">{{ $t("Host") }}</label>
                    <input class="form-control" :value="host" readonly>
                </div>
                <div class="col-md-6">
                    <label class="form-label">{{ $t("Port") }}</label>
                    <input class="form-control" :value="port" readonly>
                </div>
                <div class="col-md-6">
                    <label class="form-label">{{ $t("Username") }}</label>
                    <input class="form-control" :value="$root.username" readonly>
                </div>
                <div class="col-md-6">
                    <label class="form-label">{{ $t("Password") }}</label>
                    <input class="form-control" :value="$t('Dockge login password')" readonly>
                </div>
            </div>

            <p v-if="directories.length" class="mb-2">
                {{ $t("SFTP folders help") }}
            </p>
            <ul v-if="directories.length">
                <li v-for="directory in directories" :key="directory">
                    <code>{{ directory }}</code>
                </li>
            </ul>
            <p v-else class="text-muted">
                {{ $t("No SFTP folders") }}
            </p>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            loading: true,
            available: false,
            port: null,
            directories: [],
        };
    },

    computed: {
        host() {
            return window.location.hostname;
        },
    },

    mounted() {
        this.$root.getSocket().emit("getSftpInfo", (res) => {
            this.loading = false;
            if (!res.ok) {
                this.$root.toastRes(res);
                return;
            }
            this.available = res.available;
            this.port = res.port;
            this.directories = res.directories;
        });
    },
};
</script>
