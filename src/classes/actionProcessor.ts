import * as dotProp from "dot-prop";
import { api } from "../index";
import { log, ActionheroLogLevel } from "../modules/log";
import { utils } from "../modules/utils";
import { config } from "./../modules/config";
import { Action } from "./action";
import { Connection } from "./connection";
import { Input } from "./input";

export enum ActionsStatus {
  Complete,
  GenericError,
  ServerShuttingDown,
  TooManyRequests,
  UnknownAction,
  UnsupportedServerType,
  MissingParams,
  ValidatorErrors,
}

export class ActionProcessor<ActionClass extends Action> {
  connection: Connection;
  action: ActionClass["name"];
  toProcess: boolean;
  toRender: boolean;
  messageId: number | string;
  params: {
    action?: string;
    apiVersion?: string | number;
    [key: string]: any;
  };
  // params: ActionClass["inputs"];
  missingParams: Array<string>;
  validatorErrors: Array<string | Error>;
  actionStartTime: number;
  actionTemplate: ActionClass;
  working: boolean;
  response: {
    [key: string]: any;
  };
  duration: number;
  actionStatus: ActionsStatus;

  // allow for setting of any value via middleware
  session: any;

  constructor(connection: Connection) {
    this.connection = connection;
    this.action = null;
    this.toProcess = true;
    this.toRender = true;
    this.messageId = connection.messageId || 0;
    this.params = Object.assign(
      { action: null, apiVersion: null },
      connection.params
    );
    this.missingParams = [];
    this.validatorErrors = [];
    this.actionStartTime = null;
    this.actionTemplate = null;
    this.working = false;
    this.response = {};
    this.duration = null;
    this.actionStatus = null;
    this.session = {};
  }

  private incrementTotalActions(count = 1) {
    this.connection.totalActions = this.connection.totalActions + count;
  }

  private incrementPendingActions(count = 1) {
    this.connection.pendingActions = this.connection.pendingActions + count;
    if (this.connection.pendingActions < 0) {
      this.connection.pendingActions = 0;
    }
  }

  getPendingActionCount() {
    return this.connection.pendingActions;
  }

  private async completeAction(
    status: ActionsStatus,
    _error?: NodeJS.ErrnoException
  ) {
    let error: NodeJS.ErrnoException | string = null;
    this.actionStatus = status;

    if (status === ActionsStatus.GenericError) {
      error =
        typeof config.errors.genericError === "function"
          ? await config.errors.genericError(this, _error)
          : _error;
    } else if (status === ActionsStatus.ServerShuttingDown) {
      error = await config.errors.serverShuttingDown(this);
    } else if (status === ActionsStatus.TooManyRequests) {
      error = await config.errors.tooManyPendingActions(this);
    } else if (status === ActionsStatus.UnknownAction) {
      error = await config.errors.unknownAction(this);
    } else if (status === ActionsStatus.UnsupportedServerType) {
      error = await config.errors.unsupportedServerType(this);
    } else if (status === ActionsStatus.MissingParams) {
      error = await config.errors.missingParams(this, this.missingParams);
    } else if (status === ActionsStatus.ValidatorErrors) {
      error = await config.errors.invalidParams(this, this.validatorErrors);
    } else if (status) {
      error = _error;
    }

    if (typeof error === "string") error = new Error(error);

    if (error && (typeof this.response === "string" || !this.response.error)) {
      if (typeof this.response === "string" || Array.isArray(this.response)) {
        //@ts-ignore
        this.response = error.toString();
      } else {
        this.response.error = error;
      }
    }

    this.incrementPendingActions(-1);
    this.duration = new Date().getTime() - this.actionStartTime;
    this.working = false;
    this.logAndReportAction(status, error);

    return this;
  }

  private logAndReportAction(
    status: ActionsStatus,
    error: NodeJS.ErrnoException
  ) {
    const { type, rawConnection } = this.connection;

    let logLevel: ActionheroLogLevel = "info";
    if (this.actionTemplate && this.actionTemplate.logLevel) {
      logLevel = this.actionTemplate.logLevel;
    }

    const filteredParams = utils.filterObjectForLogging(this.params);
    let logLine = {
      to: this.connection.remoteIP,
      action: this.action,
      params: JSON.stringify(filteredParams),
      duration: this.duration,
      method: type === "web" ? rawConnection.method : undefined,
      pathname: type === "web" ? rawConnection.parsedURL.pathname : undefined,
      error: "",
      response: undefined as string,
    };

    if (config.general.enableResponseLogging) {
      logLine.response = JSON.stringify(
        utils.filterResponseForLogging(this.response)
      );
    }

    if (error) {
      let errorFields;
      const formatErrorLogLine =
        config.errors.serializers.actionProcessor ||
        this.applyDefaultErrorLogLineFormat;
      ({ logLevel = "error", errorFields } = formatErrorLogLine(error));
      logLine = { ...logLine, ...errorFields };
    }

    log(`[ action @ ${this.connection.type} ]`, logLevel, logLine);

    if (
      error &&
      (status !== ActionsStatus.UnknownAction ||
        config.errors.reportUnknownActions)
    ) {
      api.exceptionHandlers.action(error, logLine);
    }
  }

  applyDefaultErrorLogLineFormat(error: NodeJS.ErrnoException) {
    const logLevel = "error" as ActionheroLogLevel;
    const errorFields: { error: string } = { error: null };
    if (error instanceof Error) {
      errorFields.error = error.toString();
      Object.getOwnPropertyNames(error)
        .filter((prop) => prop !== "message")
        .sort((a, b) => (a === "stack" || b === "stack" ? -1 : 1))
        //@ts-ignore
        .forEach((prop) => (errorFields[prop] = error[prop]));
    } else {
      try {
        errorFields.error = JSON.stringify(error);
      } catch (e) {
        errorFields.error = String(error);
      }
    }

    return { errorFields, logLevel };
  }

  private async preProcessAction() {
    const processorNames = api.actions.globalMiddleware.slice(0);

    if (this.actionTemplate.middleware) {
      this.actionTemplate.middleware.forEach(function (m) {
        processorNames.push(m);
      });
    }

    for (const i in processorNames) {
      const name = processorNames[i];
      if (typeof api.actions.middleware[name].preProcessor === "function") {
        await api.actions.middleware[name].preProcessor(this);
      }
    }
  }

  private async postProcessAction() {
    const processorNames = api.actions.globalMiddleware.slice(0);

    if (this.actionTemplate.middleware) {
      this.actionTemplate.middleware.forEach((m) => {
        processorNames.push(m);
      });
    }

    for (const i in processorNames) {
      const name = processorNames[i];
      if (typeof api.actions.middleware[name].postProcessor === "function") {
        await api.actions.middleware[name].postProcessor(this);
      }
    }
  }

  private reduceParams(schemaKey?: string) {
    let inputs = this.actionTemplate.inputs || {};
    let params = this.params;

    if (schemaKey) {
      inputs = this.actionTemplate.inputs[schemaKey].schema;
      params = this.params[schemaKey];
    }

    const inputNames = Object.keys(inputs) || [];
    if (config.general.disableParamScrubbing !== true) {
      for (const p in params) {
        if (
          api.params.globalSafeParams.indexOf(p) < 0 &&
          inputNames.indexOf(p) < 0
        ) {
          delete params[p];
        }
      }
    }
  }

  private prepareStringMethod(method: string): Function {
    const cmdParts = method.split(".");
    const cmd = cmdParts.shift();
    if (cmd !== "api") {
      throw new Error("cannot operate on a method outside of the api object");
    }
    return dotProp.get(api, cmdParts.join("."));
  }

  private async validateParam(
    props: Input,
    params: ActionProcessor<any>["params"],
    key: string,
    schemaKey: string
  ) {
    // default
    if (params[key] === undefined && props.default !== undefined) {
      if (typeof props.default === "function") {
        params[key] = await props.default.call(this, params[key]);
      } else {
        params[key] = props.default;
      }
    }

    // formatter
    if (params[key] !== undefined && props.formatter !== undefined) {
      if (!Array.isArray(props.formatter)) {
        props.formatter = [props.formatter];
      }

      for (const i in props.formatter) {
        const formatter = props.formatter[i];
        if (typeof formatter === "function") {
          params[key] = await formatter.call(this, params[key]);
        } else {
          const method = this.prepareStringMethod(formatter);
          params[key] = await method.call(this, params[key]);
        }
      }
    }

    // validator
    if (params[key] !== undefined && props.validator !== undefined) {
      if (!Array.isArray(props.validator)) {
        props.validator = [props.validator];
      }

      for (const j in props.validator) {
        const validator = props.validator[j];
        let validatorResponse;
        try {
          if (typeof validator === "function") {
            validatorResponse = await validator.call(this, params[key]);
          } else {
            const method = this.prepareStringMethod(validator);
            validatorResponse = await method.call(this, params[key]);
          }

          // validator function returned nothing; assume param is OK
          if (validatorResponse === null || validatorResponse === undefined) {
            return;
          }

          // validator returned something that was not `true`
          if (validatorResponse !== true) {
            if (validatorResponse === false) {
              this.validatorErrors.push(
                new Error(`Input for parameter "${key}" failed validation!`)
              );
            } else {
              this.validatorErrors.push(validatorResponse);
            }
          }
        } catch (error) {
          // validator threw an error
          this.validatorErrors.push(error);
        }
      }
    }

    // required
    if (props.required === true) {
      if (config.general.missingParamChecks.indexOf(params[key]) >= 0) {
        let missingKey = key;
        if (schemaKey) {
          missingKey = `${schemaKey}.${missingKey}`;
        }
        this.missingParams.push(missingKey);
      }
    }
  }

  private async validateParams(schemaKey?: string) {
    let inputs = this.actionTemplate.inputs || {};
    let params = this.params;

    if (schemaKey) {
      inputs = this.actionTemplate.inputs[schemaKey].schema;
      params = this.params[schemaKey];
    }

    for (const key in inputs) {
      const props = inputs[key];
      await this.validateParam(props, params, key, schemaKey);

      if (props.schema && params[key]) {
        this.reduceParams(key);
        await this.validateParams(key);
      }
    }
  }

  lockParams() {
    this.params = Object.freeze(this.params);
  }

  async processAction(
    actionName?: string,
    apiVersion = this.params.apiVersion
  ) {
    this.actionStartTime = new Date().getTime();
    this.working = true;
    this.incrementTotalActions();
    this.incrementPendingActions();
    this.action = actionName || this.params.action;

    if (api.actions.versions[this.action]) {
      if (!apiVersion) {
        apiVersion =
          api.actions.versions[this.action][
            api.actions.versions[this.action].length - 1
          ];
      }

      //@ts-ignore
      this.actionTemplate = api.actions.actions[this.action][apiVersion];

      // send back the version we use to send in the api response
      if (!this.params.apiVersion) this.params.apiVersion = apiVersion;
    }

    if (api.running !== true) {
      return this.completeAction(ActionsStatus.ServerShuttingDown);
    }

    if (this.getPendingActionCount() > config.general.simultaneousActions) {
      return this.completeAction(ActionsStatus.TooManyRequests);
    }

    if (!this.action || !this.actionTemplate) {
      return this.completeAction(ActionsStatus.UnknownAction);
    }

    if (
      this.actionTemplate.blockedConnectionTypes &&
      this.actionTemplate.blockedConnectionTypes.indexOf(
        this.connection.type
      ) >= 0
    ) {
      return this.completeAction(ActionsStatus.UnsupportedServerType);
    }

    return this.runAction();
  }

  private async runAction() {
    try {
      const preProcessResponse = await this.preProcessAction();
      if (preProcessResponse !== undefined && preProcessResponse !== null) {
        Object.assign(this.response, preProcessResponse);
      }

      await this.reduceParams();
      await this.validateParams();
      this.lockParams();
    } catch (error) {
      return this.completeAction(ActionsStatus.GenericError, error);
    }

    if (this.missingParams.length > 0) {
      return this.completeAction(ActionsStatus.MissingParams);
    }

    if (this.validatorErrors.length > 0) {
      return this.completeAction(ActionsStatus.ValidatorErrors);
    }

    if (this.toProcess === true) {
      try {
        const actionResponse = await this.actionTemplate.run(this);
        if (actionResponse !== undefined && actionResponse !== null) {
          Object.assign(this.response, actionResponse);
        }

        const postProcessResponse = await this.postProcessAction();
        if (postProcessResponse !== undefined && postProcessResponse !== null) {
          Object.assign(this.response, postProcessResponse);
        }

        return this.completeAction(ActionsStatus.Complete);
      } catch (error) {
        return this.completeAction(ActionsStatus.GenericError, error);
      }
    } else {
      return this.completeAction(ActionsStatus.Complete);
    }
  }
}
