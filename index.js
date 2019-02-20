"use strict";

const AWS = require("aws-sdk");
const util = require("util");
const chalk = require("chalk");

class ServerlessPlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider("aws");
    try {
      this.servicename = this.serverless.service.getServiceName();
      this.stage = this.provider.getStage();
      this.region = this.provider.getRegion();

      AWS.config.update({
        region: this.region
      });

      this.cognitoISP = new AWS.CognitoIdentityServiceProvider({
        apiVersion: "2016-04-18"
      });

      this.stackname = this.servicename + "-" + this.stage;

      this.hooks = {
        // deploy
        "after:aws:package:finalize:mergeCustomProviderResources": this.addOutputs.bind(
          this
        ),
        "after:deploy:deploy": this.processDeploy.bind(this),
        // remove
        "before:remove:remove": this.processRemove.bind(this)
      };
    } catch (error) {
      this.serverless.cli.log(error.stack);
    }
  }

  //===================================
  // Remove: before:remove:remove

  async processRemove() {
    const names = await this.getSLSUserPoolNames();
    if (!names) {
      return;
    }

    // get userpool strutures from aws
    var userPools = await this.getAWSCognitoUserPools();
    if (!userPools) {
      return;
    }

    // process only the aws userpools that are defined on serverless.yml
    const userPoolsToProcess = userPools.filter(up => names.includes(up.Name));

    if (userPoolsToProcess.length == 0) {
    }

    userPoolsToProcess.forEach(async userPool => {
      await this.deleteUserPoolDomain(userPool.Id, userPool.Name);
    });
  }

  async getSLSUserPoolNames() {
    const resources =
      this.serverless.service.resources &&
      this.serverless.service.resources.Resources;
    if (!resources || typeof resources !== "object") {
      return;
    }
    return Object.values(resources)
      .filter(resource => {
        return resource.Type === "AWS::Cognito::UserPool";
      })
      .map(resource => resource.Properties.UserPoolName);
  }

  async getAWSCognitoUserPools() {
    var userpools = [];
    var params = {
      MaxResults: 1 /* required */
      /* NextToken: 'STRING_VALUE' */
    };
    var hasNext = true;
    while (hasNext) {
      await this.cognitoISP
        .listUserPools(params)
        .promise()
        .then(data => {
          if (data.UserPools.length != 0) {
            Array.prototype.push.apply(userpools, data.UserPools);
            userpools.concat(data.UserPools);
            if (data.NextToken) {
              params.NextToken = data.NextToken;
            } else {
              hasNext = false;
            }
          } else {
            hasNext = false;
          }
        })
        .catch(error => {
          this.log(util.format("Error: %s, '%s'", error.code, error.message));
        });
    }
    if (userpools.length == 0) {
      return null;
    } else {
      return userpools;
    }
  }

  async deleteUserPoolDomain(userPoolID, domainName) {
    var that = this;
    this.log(
      `Deleting user pool domain "${domainName}" for pool with ID ${userPoolID}...`
    );
    try {
      await this.cognitoISP.deleteUserPoolDomain({
        Domain: domainName,
        UserPoolId: userPoolID
      });
      that.log("Domain deleted");
    } catch (error) {
      that.log(util.format("Error: %s, '%s'", error.code, error.message));
    }
  }

  //===================================
  // Deploy: after:aws:package:finalize:mergeCustomProviderResources

  async addOutputs() {
    var resources = this.serverless.service.provider
      .compiledCloudFormationTemplate.Resources;
    for (let key in resources) {
      if (resources[key].Type === "AWS::Cognito::UserPool") {
        await this.addPoolIDOutputs("UserPoolId" + key, key);
      }
    }
  }

  async addPoolIDOutputs(name, value) {
    var outputs = this.serverless.service.provider
      .compiledCloudFormationTemplate.Outputs;
    outputs[name] = { Value: { Ref: value } };
  }

  //===================================
  // Deploy: after:deploy:deploy

  async processDeploy() {
    try {
      const userPoolIDs = await this.getDeployedUserPoolIDs();
      await Promise.all(
        userPoolIDs
          .filter(upi => upi.name !== "UserPoolId")
          .map(upi => {
            const cleanName = upi.name.substring(10);
            const resource = this.serverless.service.resources.Resources[
              cleanName
            ];
            upi.domain = resource.Properties.UserPoolName;
            return upi;
          })
          .map(({ id, domain }) => {
            return this.createUserPoolDomain(id, domain);
          })
      );
    } catch (err) {
      this.log("Error: " + err.message);
      this.log(err.stack);
    }
  }

  async createUserPoolDomain(userPoolID, domainName) {
    this.log(
      `Creating user pool domain "${domainName}" on pool with ID ${userPoolID}...`
    );
    try {
      return await this.cognitoISP
        .createUserPoolDomain({
          Domain: domainName,
          UserPoolId: userPoolID
        })
        .promise()
        .then(() => {
          this.log("Domain created");
        });
    } catch (err) {
      if (err.message !== "Domain already exists.") {
        throw err;
      }
      this.log("Skipping, domain already exists");
    }
  }

  async getDeployedUserPoolIDs() {
    var userPoolIDs = [];
    try {
      var result = await this.fetchCloudFormationDescribeStacks();
      var result_array = result.Stacks[0].Outputs;
      result_array.forEach(function(item) {
        if (item.OutputKey.startsWith("UserPoolId")) {
          userPoolIDs.push({ id: item.OutputValue, name: item.OutputKey });
        }
      });
      return userPoolIDs;
    } catch (error) {
      this.log(error.stack);
    }
  }

  async fetchCloudFormationDescribeStacks() {
    try {
      var params = { StackName: this.stackname };
      return this.provider.request("CloudFormation", "describeStacks", params);
    } catch (error) {
      this.log(error.stack);
    }
  }

  async log(msg) {
    this.serverless.cli.consoleLog(
      `${chalk.yellow("AWSCognitoIDPUserPoolDomain")}: ${msg}`
    );
  }
}

module.exports = ServerlessPlugin;
