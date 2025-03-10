import * as request from "request-promise-native";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { api, Process, config, route } from "../../../../src/index";
import { routerMethods } from "../../../../src/modules/route";

let url: string;
let actionhero: Process;

const toJson = async (string: string) => {
  try {
    return JSON.parse(string);
  } catch (error) {
    return error;
  }
};

describe("Server: Web", () => {
  beforeAll(async () => {
    actionhero = new Process();
    await actionhero.start();
    url = "http://localhost:" + config.web.port;
  });

  afterAll(async () => await actionhero.stop());

  describe("routes", () => {
    let originalRoutes: typeof api.routes.routes;

    beforeAll(() => {
      originalRoutes = api.routes.routes;
      api.actions.versions.mimeTestAction = [1];
      api.actions.actions.mimeTestAction = {
        // @ts-ignore
        1: {
          name: "mimeTestAction",
          description: "I am a test",
          matchExtensionMimeType: true,
          inputs: {
            key: { required: true },
            path: { required: false },
          },
          outputExample: {},
          run: async (data) => {
            if (data.params.key === "fail") {
              throw new Error("failed");
            }

            data.response.matchedRoute = data.connection.matchedRoute;
          },
        },
      };

      api.actions.versions.login = [1, 2];
      api.actions.actions.login = {
        // @ts-ignore
        1: {
          name: "login",
          description: "login",
          version: 1,
          matchExtensionMimeType: true,
          inputs: {
            user_id: { required: true },
          },
          outputExample: {},
          run: async (data) => {
            data.response.user_id = data.params.user_id;
            data.response.version = 1;
          },
        },

        // @ts-ignore
        2: {
          name: "login",
          description: "login",
          version: 2,
          matchExtensionMimeType: true,
          inputs: {
            userID: { required: true },
          },
          outputExample: {},
          run: async (data) => {
            data.response.userID = data.params.userID;
            data.response.version = 2;
          },
        },

        // @ts-ignore
        three: {
          name: "login",
          description: "login",
          version: "three",
          matchExtensionMimeType: true,
          inputs: {
            userID: { required: true },
          },
          outputExample: {},
          run: async (data) => {
            data.response.userID = data.params.userID;
            data.response.version = "three";
          },
        },
      };

      api.params.buildPostVariables();
      api.routes.loadRoutes({
        all: [{ path: "/user/:userID", action: "user" }],
        get: [
          { path: "/bogus/:bogusID", action: "bogusAction" },
          { path: "/users", action: "usersList" },
          { path: "/c/:key/:value", action: "cacheTest" },
          { path: "/mimeTestAction/:key", action: "mimeTestAction" },
          { path: "/thing", action: "thing" },
          { path: "/thing/stuff", action: "thingStuff" },
          { path: "/v:apiVersion/login", action: "login" },
          { path: "/login/v:apiVersion/stuff", action: "login" },
          { path: "/login", action: "login" },
          { path: "/old_login", action: "login", apiVersion: "1" },
          {
            path: "/a/wild/:key/:path(^.*$)",
            action: "mimeTestAction",
            apiVersion: "1",
            matchTrailingPathParts: true,
          },
          {
            path: "/a/complex/:key/__:path(^.*$)",
            action: "mimeTestAction",
            apiVersion: "1",
            matchTrailingPathParts: true,
          },
        ],
        post: [{ path: "/login/:userID(^(\\d{3}|admin)$)", action: "login" }],
      });
    });

    afterAll(() => {
      api.routes.routes = originalRoutes;
      delete api.actions.versions.mimeTestAction;
      delete api.actions.actions.mimeTestAction;
      delete api.actions.versions.login;
      delete api.actions.actions.login;
    });

    test("new params will not be allowed in route definitions (an action should do it)", () => {
      expect(api.params.postVariables).not.toContain("bogusID");
    });

    test("'all' routes are duplicated properly", () => {
      route.registerRoute("all", "/other-login", "login", null);
      const loaded: Partial<Record<typeof routerMethods[number], boolean>> = {};
      const registered: Partial<Record<typeof routerMethods[number], boolean>> =
        {};
      routerMethods.forEach((verb) => {
        api.routes.routes[verb].forEach((route) => {
          if (!loaded[verb]) {
            loaded[verb] =
              route.action === "user" && route.path === "/user/:userID";
          }
          if (!registered[verb]) {
            registered[verb] =
              route.action === "login" && route.path === "/other-login";
          }
        });
      });
      expect(Object.keys(loaded).length).toEqual(routerMethods.length);
      expect(Object.keys(registered).length).toEqual(routerMethods.length);
    });

    test("unknown actions are still unknown", async () => {
      try {
        await request.get(url + "/api/a_crazy_action");
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.error).toEqual("unknown action or invalid apiVersion");
      }
    });

    test("route actions will override explicit actions, if the defined action is null", async () => {
      try {
        await request
          .get(url + "/api/user/123?action=someFakeAction")
          .then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual("user");
      }
    });

    test("returns application/json when the mime type cannot be determined for an action", async () => {
      const response = await request.get(
        url + "/api/mimeTestAction/thing.bogus",
        { resolveWithFullResponse: true }
      );
      expect(response.headers["content-type"]).toMatch(/json/);
      const body = JSON.parse(response.body);
      expect(body.matchedRoute.path).toEqual("/mimeTestAction/:key");
      expect(body.matchedRoute.action).toEqual("mimeTestAction");
    });

    test("route actions have the matched route available to the action", async () => {
      const body = await request
        .get(url + "/api/mimeTestAction/thing.json")
        .then(toJson);
      expect(body.matchedRoute.path).toEqual("/mimeTestAction/:key");
      expect(body.matchedRoute.action).toEqual("mimeTestAction");
    });

    test("Routes should recognize apiVersion as default param", async () => {
      const body = await request
        .get(url + "/api/old_login?user_id=7")
        .then(toJson);
      expect(body.user_id).toEqual("7");
      expect(body.requesterInformation.receivedParams.action).toEqual("login");
    });

    test("Routes should be mapped for GET (simple)", async () => {
      try {
        await request.get(url + "/api/users").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual(
          "usersList"
        );
      }
    });

    test("Routes should be mapped for GET (complex)", async () => {
      try {
        await request.get(url + "/api/user/1234").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual("user");
        expect(body.requesterInformation.receivedParams.userID).toEqual("1234");
      }
    });

    test("Routes should be mapped for POST", async () => {
      try {
        await request.post(url + "/api/user/1234?key=value").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual("user");
        expect(body.requesterInformation.receivedParams.userID).toEqual("1234");
        expect(body.requesterInformation.receivedParams.key).toEqual("value");
      }
    });

    test("Routes should be mapped for PUT", async () => {
      try {
        await request.put(url + "/api/user/1234?key=value").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual("user");
        expect(body.requesterInformation.receivedParams.userID).toEqual("1234");
        expect(body.requesterInformation.receivedParams.key).toEqual("value");
      }
    });

    test("Routes should be mapped for DELETE", async () => {
      try {
        await request.del(url + "/api/user/1234?key=value").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual("user");
        expect(body.requesterInformation.receivedParams.userID).toEqual("1234");
        expect(body.requesterInformation.receivedParams.key).toEqual("value");
      }
    });

    test("route params trump explicit params", async () => {
      try {
        await request.get(url + "/api/user/1?userID=2").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual("user");
        expect(body.requesterInformation.receivedParams.userID).toEqual("1");
      }
    });

    test("to match, a route much match all parts of the URL", async () => {
      try {
        await request.get(url + "/api/thing").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual(
          "thing"
        );
      }

      try {
        await request.get(url + "/api/thing/stuff").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.requesterInformation.receivedParams.action).toEqual(
          "thingStuff"
        );
      }
    });

    test("regexp matches will provide proper variables", async () => {
      const body = await request.post(url + "/api/login/123").then(toJson);
      expect(body.requesterInformation.receivedParams.action).toEqual("login");
      expect(body.requesterInformation.receivedParams.userID).toEqual("123");

      const bodyAgain = await request
        .post(url + "/api/login/admin")
        .then(toJson);
      expect(bodyAgain.requesterInformation.receivedParams.action).toEqual(
        "login"
      );
      expect(bodyAgain.requesterInformation.receivedParams.userID).toEqual(
        "admin"
      );
    });

    test("regexp matches will still work with params with periods and other wacky chars", async () => {
      const body = await request
        .get(url + "/api/c/key/log_me-in.com$123.")
        .then(toJson);
      expect(body.requesterInformation.receivedParams.action).toEqual(
        "cacheTest"
      );
      expect(body.requesterInformation.receivedParams.value).toEqual(
        "log_me-in.com$123."
      );
    });

    test("regexp match failures will be rejected", async () => {
      try {
        await request.get(url + "/api/login/1234").then(toJson);
        throw new Error("should not get here");
      } catch (error) {
        expect(error.statusCode).toEqual(404);
        const body = await toJson(error.response.body);
        expect(body.error).toEqual("unknown action or invalid apiVersion");
        expect(body.requesterInformation.receivedParams.userID).toBeUndefined();
      }
    });

    describe("file extensions + routes", () => {
      test("will change header information based on extension (when active)", async () => {
        const response = await request.get(
          url + "/api/mimeTestAction/val.png",
          { resolveWithFullResponse: true }
        );
        expect(response.headers["content-type"]).toEqual("image/png");
      });

      test("will not change header information if there is a connection.error", async () => {
        try {
          await request.get(url + "/api/mimeTestAction/fail");
          throw new Error("should not get here");
        } catch (error) {
          expect(error.statusCode).toEqual(500);
          const body = await toJson(error.response.body);
          expect(error.response.headers["content-type"]).toEqual(
            "application/json; charset=utf-8"
          );
          expect(body.error).toEqual("failed");
        }
      });

      test("works with with matchTrailingPathParts", async () => {
        const body = await request
          .get(url + "/api/a/wild/theKey/and/some/more/path")
          .then(toJson);
        expect(body.requesterInformation.receivedParams.action).toEqual(
          "mimeTestAction"
        );
        expect(body.requesterInformation.receivedParams.path).toEqual(
          "and/some/more/path"
        );
        expect(body.requesterInformation.receivedParams.key).toEqual("theKey");
      });

      test("works with with matchTrailingPathParts and ignored variable prefixes", async () => {
        const body = await request
          .get(url + "/api/a/complex/theKey/__path-stuff")
          .then(toJson);
        expect(body.requesterInformation.receivedParams.action).toEqual(
          "mimeTestAction"
        );
        expect(body.requesterInformation.receivedParams.path).toEqual(
          "path-stuff"
        );
        expect(body.requesterInformation.receivedParams.key).toEqual("theKey");
      });
    });

    describe("spaces in URL with public files", () => {
      const source = path.join(
        __dirname,
        "/../../../../public/logo/actionhero.png"
      );

      beforeAll(async () => {
        const tmpDir = os.tmpdir();
        const readStream = fs.createReadStream(source);
        api.staticFile.searchLocations.push(tmpDir);

        await new Promise((resolve) => {
          readStream.pipe(
            fs.createWriteStream(
              tmpDir + path.sep + "actionhero with space.png"
            )
          );
          readStream.on("close", resolve);
        });
      });

      afterAll(() => {
        fs.unlinkSync(os.tmpdir() + path.sep + "actionhero with space.png");
        api.staticFile.searchLocations.pop();
      });

      test("will decode %20 or plus sign to a space so that file system can read", async () => {
        const response = await request.get(
          url + "/actionhero%20with%20space.png",
          { resolveWithFullResponse: true }
        );
        expect(response.statusCode).toEqual(200);
        expect(response.body).toMatch(/PNG/);
        expect(response.headers["content-type"]).toEqual("image/png");
      });

      test("will capture bad encoding in URL and return NOT FOUND", async () => {
        try {
          await request.get(url + "/actionhero%20%%%%%%%%%%with+space.png");
          throw new Error("should not get here");
        } catch (error) {
          expect(error.statusCode).toEqual(404);
          expect(typeof error.response.body).toEqual("string");
          expect(error.response.body).toMatch(/^that file is not found/);
        }
      });
    });

    describe("versions", () => {
      test("versions can be numbers", async () => {
        const body = await request
          .get(url + "/api/v1/login?user_id=123")
          .then(toJson);
        expect(body.version).toEqual(1);
        expect(body.user_id).toEqual("123");
      });

      test("versions can be strings", async () => {
        const body = await request
          .get(url + "/api/vthree/login?userID=123")
          .then(toJson);
        expect(body.version).toEqual("three");
        expect(body.userID).toEqual("123");
      });

      test("versions have an ignored prefix", async () => {
        const body = await request
          .get(url + "/api/v1/login?user_id=123")
          .then(toJson);
        expect(body.version).toEqual(1);
        expect(body.user_id).toEqual("123");
        expect(body.requesterInformation.receivedParams.apiVersion).toBe("1");
        expect(body.requesterInformation.receivedParams.action).toBe("login");
      });

      [
        [false, "/api/v0/login"], // there is no version 0
        [true, "/api/v1/login"], // ✅
        [true, "/api/v2/login"], // ✅
        [true, "/api/vthree/login"], // ✅
        [false, "/api/v9999/login"], // there is no version 99
        [false, "/api/1/login"], // "1" is not "v1"
        [false, "/api/three/login"], // "1" is not "v3"
        [true, "/api/login"], // ✅
        [false, "/api/foo/login"], // foo is not a matching prefix
        [false, "/api/vv/login"], // "v" is not a version
        [false, "/api/login/v1"], // "stuff" is needed at the end
        [true, "/api/login/v1/stuff"], // ✅
        [true, "/api/login/v2/stuff"], // ✅
        [true, "/api/login/vthree/stuff"], // ✅
        [false, "/api/login/v99/stuff"], // there is no version 99
      ].forEach((group) => {
        test(`routes match (${group[1]} - ${group[0]})`, async () => {
          const [match, path] = group;
          await expect(request.get(url + path).then(toJson)).rejects.toThrow(
            match
              ? "is a required parameter for this action"
              : "unknown action or invalid apiVersion"
          );
        });
      });

      test("routes with no version will default to the highest version number", async () => {
        // sorting numerically, 2 > 'three'
        const body = await request
          .get(url + "/api/login?userID=123")
          .then(toJson);
        expect(body.version).toEqual(2);
        expect(body.userID).toEqual("123");
      });
    });
  });

  describe("manually set routes persist a reload", () => {
    let originalRoutes: typeof api.routes.routes;
    beforeAll(() => {
      originalRoutes = api.routes.routes;
    });
    afterAll(() => {
      api.routes.routes = originalRoutes;
    });

    test("it remembers manually loaded routes", async () => {
      route.registerRoute("get", "/a-custom-route", "randomNumber", null);
      const response = await request.get(url + "/api/a-custom-route", {
        resolveWithFullResponse: true,
      });
      expect(response.statusCode).toEqual(200);

      api.routes.loadRoutes();

      const responseAgain = await request.get(url + "/api/a-custom-route", {
        resolveWithFullResponse: true,
      });
      expect(responseAgain.statusCode).toEqual(200);
    });
  });
});
