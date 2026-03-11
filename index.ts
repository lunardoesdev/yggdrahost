import {Elysia, t} from 'elysia'
import retrolunarSpacetechnologyNet from './modules/retrolunar.spacetechnology.net';

const apiExample = new Elysia()
    .get("/", () => "api root")

var app = new Elysia()
retrolunarSpacetechnologyNet.setup(app, "/")

app.listen(3000)
