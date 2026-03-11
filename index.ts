import {Elysia, t} from 'elysia'
import retrolunarSpacetechnologyNet from './modules/retrolunar.spacetechnology.net';

const apiExample = new Elysia()
    .get("/", () => "api root")

const retrolunarSpaceTechnologyNetApp = retrolunarSpacetechnologyNet.setup(new Elysia(), "/")


const app = new Elysia()
    .onBeforeHandle((request) => {
        const host = request.headers.host?.split(":")[0];
        if (host == "api.example.com") {
          return apiExample.handle(request.request)
        } else if (host == "retrolunar.spacetechnology.net") {
          return retrolunarSpaceTechnologyNetApp.handle(request.request)
        }
    })
    .listen(3000)