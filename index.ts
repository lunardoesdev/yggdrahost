import {Elysia, t} from 'elysia'

const apiExample = new Elysia()
    .get("/", () => "api root")

const app = new Elysia()
    .onBeforeHandle((request) => {
        const host = request.headers.host?.split(":")[0];
        if (host == "api.example.com") {
            return apiExample.handle(request.request)
        }
    })