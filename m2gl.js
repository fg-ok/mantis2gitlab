#!/usr/bin/env node

const Q = require('q');
const FS = require('q-io/fs');
const csv = require('csv');
const superagent = require('superagent');
const _ = require('lodash');
const argv = require('optimist')
    .demand(['i', 'c', 'g', 'p', 't', 's'])
    .alias('i', 'input')
    .alias('c', 'config')
    .alias('g', 'gitlaburl')
    .alias('p', 'project')
    .alias('t', 'token')
    .alias('s', 'sudo')
    .alias('f', 'from')
    .alias('n', 'dryrun')
    .alias('v', 'verbose')
    .alias('rms', 'removeSkipped')
    .boolean('n')
    .boolean('v')
    .boolean('rms')
    .describe('i', 'CSV file exported from Mantis (Example: issues.csv)')
    .describe('c', 'Configuration file (Example: config.json)')
    .describe('g', 'GitLab URL hostname (Example: https://gitlab.com)')
    .describe('p', 'GitLab project name including namespace (Example: mycorp/myproj)')
    .describe('t', 'An admin user\'s private token (Example: a2r33oczFyQzq53t23Vj)')
    .describe('s', 'The username performing the import (Example: bob)')
    .describe('f', 'The first issue # to import (Example: 123)')
    .describe('n', 'Dry run, just output actions that would be executed')
    .describe('v', 'Verbose output, print every step more detailed')
    .describe('rms', 'Remove existing Gitlab issues with title starting with "Skipped Mantis Issue"; if set no migration will be executed!')
    .argv;

const inputFile = __dirname + '/' + argv.input;
const configFile = __dirname + '/' + argv.config;
const fromIssueId = Number(argv.from || 0);
const gitlabAPIURLBase = argv.gitlaburl + '/api/v4';
const gitlabProjectName = argv.project;
const gitlabAdminPrivateToken = argv.token;
const gitlabSudo = argv.sudo;
const removeSkipped = argv.rms;
const dryRun = argv.dryrun;
const verbose = argv.verbose;
let config = {};

let gitLab = {};
let promise = getConfig()
    .then(readMantisIssues)
    .then(getGitLabProject)
    .then(getGitLabProjectMembers)
    .then(mapGitLabUserIds)
    .then(getGitLabProjectMilestones)
    .then(mapGitLabMilestoneIds)
    .then(validateMantisIssues)
    .then(getGitLabProjectIssues)
    .then(deleteSkippedIssues)
    .then(importGitLabIssues)
;

promise.then(function () {
    console.log(("Done!").green);
}, function (err) {
    console.error(err);
});

/**
 * Read and parse config.json file - assigns config
 */
function getConfig() {
    verbose ? log_verbose('Read from file ' + configFile) : log_progress("Reading configuration...");
    return FS.read(configFile, {encoding: 'utf8'})
        .then(function (data) {
            let config = JSON.parse(data);
            config.users = _.extend({
                "": {
                    name: "Unknown",
                    gl_username: gitlabSudo
                }
            }, config.users);
            return config;
        }).then(function (cfg) {
            config = cfg;
        }, function () {
            throw new Error('Cannot read config file: ' + configFile);
        });
}

/**
 * Read and parse import.csv file - assigns gitLab.mantisIssues
 */
function readMantisIssues() {
    verbose ? log_verbose("Reading Mantis export file from " + inputFile) : log_progress("Reading Mantis export file...");
    return FS.read(inputFile, {encoding: 'utf8'}).then(function (data) {
        var rows = [];
        var dfd = Q.defer();

        csv().from(data, {delimiter: ',', escape: '"', columns: true})
            .on('record', function (row, index) {
                rows.push(row)
            })
            .on('end', function (error, data) {
                dfd.resolve(rows);
            });

        return dfd.promise
            .then(function (rows) {
                _.forEach(rows, function (row) {
                    row.Id = Number(row.Id);
                });

                if (fromIssueId) {
                    rows = _.filter(rows, function (row) {
                        // log_verbose('ID in Mantis export file '+row.Id+' is greater than passed fromIssueId-parameter: '+fromIssueId);
                        return row.Id >= fromIssueId;
                    })
                }

                return gitLab.mantisIssues = _.sortBy(rows, "Id");
            }, function (error) {
                throw new Error('Cannot read input file: ' + inputFile + " - " + error);
            });
    });
}

/**
 * Fetch project info from GitLab - assigns gitLab.project
 */
function getGitLabProject() {
    const url = gitlabAPIURLBase + '/projects';
    let data = {per_page: 100};
    verbose ? log_verbose('Fetching project from GitLab: ' + url) : log_progress("Fetching project from GitLab...");

    return superagent
        .get(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            gitLab.project = _.find(result.body, {path_with_namespace: gitlabProjectName}) || null;
            if (!gitLab.project) {
                throw new Error('Cannot find project "' + gitlabProjectName + '" at GitLab');
            }
            return gitLab.project;
        })
        .catch((error) => {
            console.log(error);
                throw new Error('Cannot get list of projects from gitlab: ' + url + ' (error code: ' + error.status + ')');
            }
        );
}

/**
 * Fetch project members from GitLab - assigns gitLab.gitlabUsers
 */
function getGitLabProjectMembers() {
    const url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + "/members/all";
    let data = {per_page: 100};
    verbose ? log_verbose('Fetching project members from GitLab: ' + url) : log_progress("Fetching project members from GitLab...");
    return superagent
        .get(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            gitLab.gitlabUsers = result.body;
            if (!gitLab.gitlabUsers) {
                log_verbose('Found no users at Gitlab project.')
            }
            return gitLab.gitlabUsers;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Cannot get list of users from gitlab: ' + url + ' (error code: ' + error.status + ')');
                }
            }
        );
}

/**
 * Sets config.users[].gl_id based gitLab.gitlabUsers
 */
function mapGitLabUserIds() {
    let users = config.users,
        gitlabUsers = gitLab.gitlabUsers;
    _.forEach(users, function (user) {
        user.gl_id = (_.find(gitlabUsers, {username: user.gl_username}) || {}).id;
    });
    return config;
}

/**
 * Fetch project's milestones from GitLab - assigns gitLab.gitlabMilestones
 */
function getGitLabProjectMilestones() {
    const url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + "/milestones";
    let data = {per_page: 100};
    verbose ? log_verbose('Fetching project milestones from GitLab: ' + url) : log_progress("Fetching project milestones from GitLab...");
    return superagent
        .get(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            gitLab.gitlabMilestones = result.body;
            if (!gitLab.gitlabMilestones) {
                log_verbose('Found no milestones at Gitlab project.')
            }
            return gitLab.gitlabMilestones;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Cannot get list of milestones from gitlab: ' + url + ' (error code: ' + error.status + ')');
                }
            }
        );
}

/**
 * Sets config.version_milestones[].gl_milestone_id based gitLab.gitlabUsers
 */
function mapGitLabMilestoneIds() {
    let versionMilestones = config.version_milestones,
        gitlabMilestones = gitLab.gitlabMilestones;
    _.forEach(versionMilestones, function (milestone) {
        milestone.gl_id = (_.find(gitlabMilestones, {title: milestone}) || {}).id;
    });
    return config;
}

/**
 * Ensure that Mantis' user names in gitLab.mantisIssues have corresponding GitLab user mapping
 */
function validateMantisIssues() {
    log_progress("Validating Mantis users...");

    let mantisIssues = gitLab.mantisIssues;
    let users = config.users;
    let missingUsernames = [];

    log_verbose("Check if users from Mantis export have corresponding Gitlab user...");
    log_verbose("Check assignee");
    for (let i = 0; i < mantisIssues.length; i++) {
        let assignee = mantisIssues[i]["Assigned To"];

        if (!getUserByMantisUsername(assignee) && missingUsernames.indexOf(assignee) === -1)
            missingUsernames.push(assignee);
    }

    log_verbose("Check reporter");
    for (let i = 0; i < mantisIssues.length; i++) {
        let reporter = mantisIssues[i]['Reporter'];

        if (!getUserByMantisUsername(reporter) && missingUsernames.indexOf(reporter) === -1)
            missingUsernames.push(reporter);
    }

    if (missingUsernames.length > 0) {
        for (let i = 0; i < missingUsernames.length; i++)
            console.error('Error: Cannot map Mantis user with username: ' + missingUsernames[i]);

        throw new Error("User validation failed");
    }
}

/**
 * Import gitLab.mantisIssues into GitLab
 * @returns {*}
 */
function importGitLabIssues() {
    if (removeSkipped) {
        return Promise.resolve();
    }

    log_progress("Importing Mantis issues into GitLab from #" + fromIssueId + " ...");
    return _.reduce(gitLab.mantisIssues, function (p, mantisIssue) {
        return p.then(function () {
            return importIssue(mantisIssue);
        });
    }, Q());

}

function importIssue(mantisIssue) {
    let issueId = mantisIssue.Id;
    let title = mantisIssue.Summary;
    let description = getDescription(mantisIssue);
    let created_at = mantisIssue["Created"];
    let assignee = getUserByMantisUsername(mantisIssue["Assigned To"]);
    let milestoneId = getMilestoneId(mantisIssue['TargetVersion']);
    let labels = getLabels(mantisIssue);
    let author = getUserByMantisUsername(mantisIssue['Reporter']);

    let data = {
        iid: issueId,
        title: title,
        description: description,
        assignee_id: assignee && assignee.gl_id,
        milestone_id: milestoneId,
        labels: labels,
        author: author
    };

    log_progress("Importing: #" + issueId + " - " + title + " ...");
    log_verbose(data);

    return getIssue(gitLab.project.id, issueId)
        .then(function (gitLabIssue) {
            if (gitLabIssue) {
                return updateIssue(gitLab.project.id, gitLabIssue.iid, _.extend({
                    state_event: isClosed(mantisIssue) ? 'close' : 'reopen'
                }, data))
                    .then(function () {
                        console.log(("#" + issueId + ": Updated successfully.").green);
                    });
            } else {
                return insertSkippedIssues(issueId - 1)
                    .then(function () {
                        return insertAndCloseIssue(issueId, data, isClosed(mantisIssue));
                    });
            }
        });
}

function insertSkippedIssues(issueId) {
    
    if (gitLab.gitlabIssues[issueId]) {
        return Q();
    }

    console.warn(("Skipping Missing Mantis Issue (<= #" + issueId + ") ...").yellow);

    let data = {
        title: "Skipped Mantis Issue",
    };

    return insertAndCloseIssue(issueId, data, true, getSkippedIssueData)
        .then(function () {
            return insertSkippedIssues(issueId);
        });

    function getSkippedIssueData(gitLabIssue) {
        let issueId = gitLabIssue.iid;
        let description;
        if (config.mantisUrl) {
            description = "[Mantis Issue " + issueId + "](" + config.mantisUrl + "/view.php?id=" + issueId + ")";
        } else {
            description = "Mantis Issue " + issueId;
        }
        return {
            title: "Skipped Mantis Issue " + issueId,
            description: "_Skipped " + description + "_"
        };
    }
}

function insertAndCloseIssue(issueId, data, close, custom) {

    return insertIssue(gitLab.project.id, data).then(function (issue) {
        gitLab.gitlabIssues[issue.iid] = issue;
        if (close) {
            return closeIssue(issue, custom && custom(issue)).then(
                function () {
                    console.log((issueId + ': Inserted and closed successfully. #' + issue.iid).green);
                }, function (error) {
                    console.warn((issueId + ': Inserted successfully but failed to close. #' + issue.iid).yellow);
                });
        }

        console.log((issueId + ': Inserted successfully. #' + issue.iid).green);
    }, function (error) {
        console.error((issueId + ': Failed to insert.').red, error);
    });
}

/**
 * Fetch all existing project issues from GitLab - assigns gitLab.gitlabIssues
 */
function getGitLabProjectIssues() {
    return getRemainingGitLabProjectIssues(0, 100)
        .then(function (result) {
            log_progress("Fetched " + result.length + " GitLab issues.");
            let issues = _.indexBy(result, 'iid');
            return gitLab.gitlabIssues = issues;
        });
}

/**
 * Recursively fetch the remaining issues in the project
 * @param page
 * @param per_page
 */
function getRemainingGitLabProjectIssues(page, per_page) {
    let from = page * per_page;
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + "/issues";
    verbose ? log_verbose('Fetching project issues from GitLab: ' + url + ' [' + (from + 1) + '-' + (from + per_page) + ']...') : log_progress("Fetching project issues from GitLab [" + (from + 1) + "-" + (from + per_page) + "]...");

    let data = {
        page: page,
        per_page: per_page,
        order_by: 'id',
    };

    return superagent
        .get(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            let issues = result.body;

            if (issues.length < per_page) {
                return issues;
            }
            return getRemainingGitLabProjectIssues(page + 1, per_page)
                .then(function (remainingIssues) {
                    return issues.concat(remainingIssues);
                });
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Cannot get list of issues from gitlab: ' + url + " page=" + page);
                }
            }
        );
}

function getUserByMantisUsername(username) {
    return (username && config.users[username]) || config.users[""] || null;
}

function getDescription(row) {
    let attributes = [];
    let issueId = row.Id;
    let value;
    if (config.mantisUrl) {
        attributes.push("[Mantis Issue " + issueId + "](" + config.mantisUrl + "/view.php?id=" + issueId + ")");
    } else {
        attributes.push("Mantis Issue " + issueId);
    }

    if (row.hasOwnProperty('Reporter') && row.Reporter && row.Reporter !== 'NULL') {
        attributes.push("Reported By: " + row.Reporter);
    }

    if (row.hasOwnProperty('Assigned To') && row["Assigned To"] && row["Assigned To"] !== 'NULL') {
        attributes.push("Assigned To: " + row["Assigned To"]);
    }

    if (row.hasOwnProperty('Created') && row.Created && row.Created !== 'NULL') {
        attributes.push("Created: " + row.Created);
    }

    if (row.hasOwnProperty('Updated') && row.Updated && row.Updated !== 'NULL') {
        attributes.push("Updated: " + row.Updated);
    }

    let description = "_" + attributes.join(", ") + "_\n\n";

    description += row.Description;

    if (row.hasOwnProperty('Info') && row.Info && row.Info !== 'NULL') {
        description += "\n\n" + row.Info;
    }

    if (row.hasOwnProperty('Notes') && row.Notes && row.Notes !== 'NULL') {
        description += "\n\n" + row.Notes.split("$$$$").join("\n\n")
    }

    return description;
}

function getLabels(row) {
    let label;
    let labels = (row.tags || []).slice(0);

    if (config.category_labels.hasOwnProperty(row.CategoryId) && (label = config.category_labels[row.CategoryId])) {
        labels.push(label);
    }

    if (config.category_labels.hasOwnProperty(row.Priority) && (label = config.priority_labels[row.Priority])) {
        labels.push(label);
    }

    if (config.category_labels.hasOwnProperty(row.Severity) && (label = config.severity_labels[row.Severity])) {
        labels.push(label);
    }

    return labels.join(",");
}

function getMilestoneId(TargetVersion) {
    return config.version_milestones.hasOwnProperty(TargetVersion) ? config.version_milestones[TargetVersion] : '';;
}

function isClosed(row) {
    return config.closed_statuses[row.Status];
}

function getIssue(projectId, issueId) {
    return Q(gitLab.gitlabIssues[issueId]);
}

function insertIssue(projectId, data) {
    let url = gitlabAPIURLBase + '/projects/' + projectId + '/issues';

    if (dryRun) {
        log_verbose('DryRun: Create issue; send POST-request to ' + url);
        return Promise.resolve({'dryRun': 'yes', 'action': 'INSERT', 'issue': data.iid});
    }

    // Set Sudo to author-user for request if available
    let Sudo = gitlabSudo;
    if (data.hasOwnProperty('author') && data.author.hasOwnProperty('gl_username')) {
        Sudo = data.author.gl_username;
    }

    return superagent
        .post(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': Sudo, accept: 'json'})
        .send(data)
        .then((result) => {
            log_verbose('Inserted issues');
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    if (verbose && error.response) {
                        console.error(error.response.error);
                    }
                    throw new Error('Failed to insert issue into GitLab: ' + url);
                }
            }
        );
}

function updateIssue(projectId, issueIid, data) {
    let url = gitlabAPIURLBase + '/projects/' + projectId + '/issues/' + issueIid;

    if (dryRun) {
        log_verbose('DryRun: Update issue; send PUT-request to ' + url);
        console.log(data);
        return Promise.resolve({'dryRun': 'yes', 'action': 'UPDATE', 'issue': issueIid});
    }

    return superagent
        .put(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            log_verbose('Updated issue ' + issueIid);
            return result.body;
        })
        .catch((error) => {
            console.error(error);
                if (error) {
                    throw new Error('Failed to update issue in GitLab: ' + url + " " + JSON.stringify(error));
                }
            }
        );
}

function closeIssue(issue, custom) {
    let url = gitlabAPIURLBase + '/projects/' + issue.project_id + '/issues/' + issue.iid;
    let data = _.extend({
        state_event: 'close',
    }, custom);

    if (dryRun) {
        log_verbose('DryRun: Close issue; send PUT-request to ' + url);
        console.log(data);
        return Promise.resolve({'dryRun': 'yes', 'action': 'CLOSE', 'issue': issue.iid});
    }

    return superagent
        .put(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            log_verbose('Closed issue ' + issue.iid);
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Failed to close issue in GitLab: ' + url);
                }
            }
        );
}

function deleteSkippedIssues()
{
    if (!removeSkipped) {
        return Promise.resolve();
    }
    _.forEach(gitLab.gitlabIssues, function (issue) {
        if (issue.title.indexOf('Skipped Mantis Issue') === 0) {
            return deleteIssue(issue.iid);
        }
    });
}

function deleteIssue(issueIid)
{
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + '/issues/' + issueIid;

    if (dryRun) {
        log_verbose('DryRun: Delete issue; send DELETE-request to ' + url);
        return Promise.resolve({'dryRun': 'yes', 'action': 'DELETE', 'issue': issueIid});
    }

    return superagent
        .delete(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .then((result) => {
            log_verbose('Removed issue ' + issueIid);
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Failed to remove issue in GitLab: ' + url);
                }
            }
        );
}


function log_progress(message) {
    console.log(message.grey);
}

function log_verbose(message) {
    console.log(message);
}