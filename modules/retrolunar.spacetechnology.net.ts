import {Elysia} from "elysia"

export const app = new Elysia()
    .get("/", "HELLO FROM retrolunar.spacetechnology.net!")
