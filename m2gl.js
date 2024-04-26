#!/usr/bin/env node

const Q = require('q');
const FS = require('q-io/fs');
const async = require('async');
const colors = require('colors');
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
    .boolean('n')
    .boolean('v')
    .boolean('v')
    .describe('i', 'CSV file exported from Mantis (Example: issues.csv)')
    .describe('c', 'Configuration file (Example: config.json)')
    .describe('g', 'GitLab URL hostname (Example: https://gitlab.com)')
    .describe('p', 'GitLab project name including namespace (Example: mycorp/myproj)')
    .describe('t', 'An admin user\'s private token (Example: a2r33oczFyQzq53t23Vj)')
    .describe('s', 'The username performing the import (Example: bob)')
    .describe('f', 'The first issue # to import (Example: 123)')
    .describe('n', 'Dry run, just output actions that would be executed')
    .describe('v', 'Verbose output, print every step more detailed')
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
    .then(importGitLabIssues)
;

promise.then(function () {
    console.log((" Done! ").bold.white.bgGreen);
}, function (err) {
    console.error(err);
});

/**
 * Read and parse config.json file - assigns config
 * @return {PromiseLike<void>}
 */
function getConfig() {
    if (dryRun) {
        log_progress('### Started migration script in dry run mode ###');
        if (!verbose) log_progress('## It is recommend to set the verbose mode on dry run! ##');
    }
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
 * @return {object}
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
 * @return {Promise<unknown | void>}
 */
function getGitLabProject() {
    const url = gitlabAPIURLBase + '/projects';
    let queryString = 'per_page=100';
    verbose ? log_verbose('Fetching project from GitLab: ' + url) : log_progress("Fetching project from GitLab...");

    return superagent
        .get(url)
        .query(queryString)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .then((result) => {
            gitLab.project = _.find(result.body, {path_with_namespace: gitlabProjectName}) || null;
            if (!gitLab.project) {
                throw new Error('Cannot find project "' + gitlabProjectName + '" at GitLab');
            }
            return gitLab.project;
        })
        .catch((error) => {
                if (error.status !== '404') {
                    throw new Error('Cannot get list of projects from gitlab: ' + url + ' (error code: ' + error.status + ')');
                }
            }
        );
}

/**
 * Fetch project members from GitLab - assigns gitLab.gitlabUsers
 * @return {Promise<unknown | void>}
 */
function getGitLabProjectMembers() {
    const url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + "/members/all";
    let queryString = 'per_page=100';
    verbose ? log_verbose('Fetching project members from GitLab (max. 100): ' + url) : log_progress("Fetching project members from GitLab (max. 100)...");
    return superagent
        .get(url)
        .query(queryString)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
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
 * Sets "config.users[].gl_id" based on matching user from gitLab.gitlabUsers
 * @return {object}
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
 * @return {Promise<unknown | void>}
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
 * Sets config.version_milestones[].gl_milestone_id based gitLab.gitlabMilestones
 * @return {{}}
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
 * Ensure that Mantis' usernames in gitLab.mantisIssues have corresponding GitLab user mapping
 * @return void
 */
function validateMantisIssues() {
    log_progress("Validating Mantis users...");

    let mantisIssues = gitLab.mantisIssues;
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
 * @return {Promise<void>|*}
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
    let createdAt = mantisIssue["Created"];
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
        created_at: createdAt,
        labels: labels,
        author: author
    };

    log_progress('Importing: #' + issueId + ' - "' + title + '" ...');
    verbose ? log_verbose(data) : null;


    return getIssue(gitLab.project.id, issueId)
        .then(function (gitLabIssue) {
            if (gitLabIssue) {
                return updateIssue(gitLab.project.id, gitLabIssue.iid, _.extend({
                    state_event: isClosed(mantisIssue) ? 'close' : 'reopen'
                }, data))
                    .then(function () {
                        log_progress("#" + issueId + ": Updated successfully.");
                        return replaceIssueNotes(gitLabIssue.iid, mantisIssue).then((result) => {
                            return result;
                        });
                    });
            } else {
                return insertIssue(gitLab.project.id, data).then(function (issue) {
                    gitLab.gitlabIssues[issue.iid] = issue;
                    if (isClosed(mantisIssue)) {
                        return closeIssue(issue, {}).then(
                            function () {
                                log_progress(issueId + ': Inserted and closed successfully. #' + issue.iid);
                            }, function (error) {
                                console.warn((issueId + ': Inserted successfully but failed to close. #' + issue.iid).yellow);
                            });
                    }
                    log_progress(issueId + ': Inserted successfully. #' + issue.iid);
                    return replaceIssueNotes(issue.iid, mantisIssue)
                        .then((result) => {
                            return result;
                        });
                }, function (error) {
                    console.error((issueId + ': Failed to insert.').red, error);
                });
            }
        });
}

/**
 * Fetch all existing project issues from GitLab - assigns gitLab.gitlabIssues
 * @return {any}
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
 * @param {int} page
 * @param {int} per_page
 * @return {Promise<unknown | void>}
 */
function getRemainingGitLabProjectIssues(page, per_page) {
    let from = page * per_page;
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + "/issues";
    verbose ? log_verbose('Fetching project issues from GitLab: ' + url + ' [' + (from + 1) + '-' + (from + per_page) + ']...') : log_progress("Fetching project issues from GitLab [" + (from + 1) + "-" + (from + per_page) + "]...");


    let queryString = 'scope=all&page='+page+'&per_page='+per_page+'&order_by=created_at';
    return superagent
        .get(url)
        .query(queryString)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
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

/**
 * Get corresponding GitLab username to passed username from Mantis
 * @param {string} username
 * @return {{name: string, gl_username: string}|null}
 */
function getUserByMantisUsername(username) {
    return (username && config.users[username]) || config.users[""] || null;
}

/**
 * Compose issue body/description from Mantis' key data (URL, reporter, date created) and  actual description
 * @param {object} row
 * @return {string}
 */
function getDescription(row) {
    let attributes = [];
    let issueId = row.Id;

    if (config.mantisUrl) {
        attributes.push("[Mantis Issue " + issueId + "](" + config.mantisUrl + "/view.php?id=" + issueId + ")");
    } else {
        attributes.push("Mantis Issue " + issueId);
    }

    if (row.hasOwnProperty('Reporter') && row.Reporter && row.Reporter !== 'NULL') {
        attributes.push("Reported By: @" + row.Reporter);
    }

    if (row.hasOwnProperty('Assigned To') && row["Assigned To"] && row["Assigned To"] !== 'NULL') {
        attributes.push("Assigned To: @" + row["Assigned To"]);
    }

    if (row.hasOwnProperty('Created') && row.Created && row.Created !== 'NULL') {
        attributes.push("Created: " + row.Created);
    }

    if (row.hasOwnProperty('Updated') && row.Updated && row.Updated !== 'NULL') {
        attributes.push("Updated: " + row.Updated);
    }

    let description = "_" + attributes.join(", ") + "_\n\n\n----\n";

    description += row.Description + "\n\n";

    if (row.hasOwnProperty('Info') && row.Info && row.Info !== 'NULL') {
        description += "\n\n----\n_Info:_\n" + row.Info;
    }

    return description;
}

/**
 * Extract individual notes from Mantis data row
 * @param {object} row
 * @return {*[]|null}
 */
function getNotes(row)
{
    if (!row.hasOwnProperty('Notes') || !row.Notes || row.Notes === 'NULL') {
        return null;
    }

    let regexp = /([\dTZ:-]+)(]\[)([a-z]+)(]\[)((.|\n)*)/;
    let matches;
    let noteData = [];
    let noteRows = row.Notes.split("$$$$");
    _.forEach(noteRows, function (row) {
        matches = row.match(regexp);
        noteData.push({
            created_at: matches[1],
            author: matches[3],
            body: '_via Mantis:_ ' + matches[5],
        });
    });

    return noteData;
}

/**
 * Return comma separated GitLab labels matching categories, priorities and severities from Mantis
 * @param {object} row
 * @return {string}
 */
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

/**
 * Get corresponding GitLab milestone-id to passed version name from Mantis
 * @param {string} TargetVersion
 * @return {string}
 */
function getMilestoneId(TargetVersion) {
    return config.version_milestones.hasOwnProperty(TargetVersion) ? config.version_milestones[TargetVersion] : '';;
}

/**
 * Returns if Mantis issue in "row" is a closed one
 * @param {object} row
 * @return {boolean}
 */
function isClosed(row) {
    return config.closed_statuses[row.Status];
}

/**
 * Get specific issue with issueId of given projectId from GitLab issues read/cached before
 * @param {int} projectId
 * @param {int} issueId
 * @return {object}
 */
function getIssue(projectId, issueId) {
    return Q(gitLab.gitlabIssues[issueId]);
}

/**
 * The actual creation of GitLab issue in "projectId" with "data"
 * @param {int} projectId
 * @param {object} data
 * @return {Promise<Awaited<{dryRun: string, issue: (*|number), action: string}>>|Promise<unknown | void>}
 */
function insertIssue(projectId, data) {
    let url = gitlabAPIURLBase + '/projects/' + projectId + '/issues';

    if (dryRun) {
        verbose ? log_verbose('DryRun: Create issue; send POST-request to ' + url) : null;
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
            verbose ? log_verbose('Inserted issues') : null;
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    if (verbose && error.response) {
                        console.error(error.response);
                    }
                    throw new Error('Failed to insert issue into GitLab: ' + url);
                }
            }
        );
}

/**
 * The actual updating of GitLab issue "issueIid" in "projectId" with "data".
 * Usually this function is not called because a migration runs smoothly on first call (but maybe you want one want a
 * second run)
 * @param {int} projectId
 * @param {int} issueIid
 * @param {object} data
 * @return {Promise<unknown | void>|Promise<Awaited<{dryRun: string, issue, action: string}>>}
 */
function updateIssue(projectId, issueIid, data) {
    let url = gitlabAPIURLBase + '/projects/' + projectId + '/issues/' + issueIid;

    if (dryRun) {
        verbose ? log_verbose('DryRun: Update issue; send PUT-request to ' + url) : null;
        return Promise.resolve({'dryRun': 'yes', 'action': 'UPDATE', 'issue': issueIid});
    }

    return superagent
        .put(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            verbose ? log_verbose('Updated issue ' + issueIid) : null;
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Failed to update issue in GitLab: ' + url + " " + JSON.stringify(error));
                }
            }
        );
}

/**
 * Just set GitLab issue to status closed
 * @param {object} issue
 * @return {Promise<Awaited<{dryRun: string, issue: (*|number), action: string}>>|Promise<unknown | void>}
 */
function closeIssue(issue) {
    let url = gitlabAPIURLBase + '/projects/' + issue.project_id + '/issues/' + issue.iid;
    let data = {
        state_event: 'close'
    };

    if (dryRun) {
        log_verbose('DryRun: Close issue; send PUT-request to ' + url);
        verbose ? log_verbose(data) : null;
        return Promise.resolve({'dryRun': 'yes', 'action': 'CLOSE', 'issue': issue.iid});
    }

    return superagent
        .put(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .send(data)
        .then((result) => {
            verbose ? log_verbose('Closed issue ' + issue.iid) : null;
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Failed to close issue in GitLab: ' + url);
                }
            }
        );
}

/**
 * Keep function for any remove jobs to come
 * @deprecated Insertion of "skip issues" to force specific issues-ids not needed anymore, so no more "skip issues" to delete
 * @return {Promise<Awaited<unknown>[]>|Promise<void>}
 */
function deleteSkippedIssues()
{
    if (!removeSkipped) {
        return Promise.resolve();
    }

    let promises = [];
    _.forEach(gitLab.gitlabIssues, function (issue) {
        if (issue.title.indexOf('Skipped Mantis Issue') === 0) {
            promises.push(deleteIssue(issue.iid));
        }
    });
    return Promise.all(promises).then((values) => { return values;});
}

/**
 *
 * @param {int} issueIid
 * @return {Promise<unknown | void>}
 */
function deleteIssue(issueIid)
{
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + '/issues/' + issueIid;

    if (dryRun) {
        verbose ? log_verbose('DryRun: Delete issue; send DELETE-request to ' + url) : null;
        return Promise.resolve({'dryRun': 'yes', 'action': 'DELETE', 'issue': issueIid});
    }

    return superagent
        .delete(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .then((result) => {
            verbose ? log_verbose('Removed issue ' + issueIid) : null;
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    throw new Error('Failed to remove issue in GitLab: ' + url);
                }
            }
        );
}

/**
 * @param {int} issueIid
 * @param {boolean} onlyMantisNotes (optional) defaults to TRUE; only remove notes from Mantis migration (=notes
 *                                  starting with "_via Mantis:_")
 * @return {Promise<unknown | {func: string, error: *}>}
 */
function deleteAllIssueNotes(issueIid, onlyMantisNotes)
{
    onlyMantisNotes = 'undefined' !== typeof onlyMantisNotes && onlyMantisNotes;
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + '/issues/' + issueIid + '/notes';

    verbose ? log_verbose('Remove notes from issue ' + issueIid + ', with onlyMantisNotes='+onlyMantisNotes+'...') : log_progress('Remove notes from issue ' + issueIid + '...');
    if (dryRun) {
        verbose ? log_verbose('DryRun: Read notes to issue ' + issueIid + '; send GET-request to ' + url) : null;
    }

    return superagent
        .get(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .then((result) => {
            _.forEach(result.body, function (note) {
                if (!onlyMantisNotes || (onlyMantisNotes && note.body.indexOf('_via Mantis:_') === 0)) {
                    return deleteIssueNote(issueIid, note.id);
                }
            });
        })
        .catch((error) => {
            verbose ? log_verbose('Cannot get list of notes from gitlab: ' + url + ' (error code: ' + error.status + ')') : null;
            return {'error': error, 'func': 'deleteAllIssueNotes'};
        });
}

/**
 * Remove single note from issueIid
 * @param {int} issueIid
 * @param {int} noteId
 * @return {Promise<unknown | boolean>|Promise<Awaited<{note, dryRun: string, issue, action: string}>>}
 */
function deleteIssueNote(issueIid, noteId)
{
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + '/issues/' + issueIid + '/notes/' + noteId;
    if (dryRun) {
        verbose ? log_verbose('DryRun: Delete note ' + noteId + ' of issue ' + issueIid + '; send DELETE-request to ' + url) : null;
        return Promise.resolve({'dryRun': 'yes', 'action': 'DELETE', 'issue': issueIid, 'note': noteId});
    }

    return superagent
        .delete(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': gitlabSudo, accept: 'json'})
        .then((result) => {
            verbose ? log_verbose('Removed note ' + issueIid + '/' + noteId) : null;
            return result.status;
        })
        .catch((error) => {
                if (403 === error.status) {
                    // verbose ? log_verbose('Deleting note ' + issueIid + '/' + noteId + ' forbidden') : null;
                    return false;
                }
                if (error) {
                    throw new Error('Failed to remove note of issue in GitLab: ' + url);
                }
            }
        );
}

/**
 * Refresh notes on issue (remove and add). Remove [All|Only the previous from Mantis imported (default)] notes
 * before attaching notes of given mantisIssue.
 * @param {int} issueId
 * @param {object} mantisIssue
 */
function replaceIssueNotes(issueId, mantisIssue)
{
    return deleteAllIssueNotes(issueId, true).then((result) => {
        let mantisNotes = getNotes(mantisIssue);
        let promises = [];
        if (mantisNotes && mantisNotes.length) {
            verbose ? log_verbose('Add ' + mantisNotes.length + ' note(s) to issue ' + issueId) : log_progress('Add ' + getNotes(mantisIssue).length + ' note(s) to issue ' + issueId);
            _.forEach(mantisNotes, function (row) {
                _.extend({author: getUserByMantisUsername(row.author)}, row);
                promises.push(addNote(issueId, row));
            });
            return Promise.all(promises).then((values) => {
                return values;
            });
        }

        return Promise.resolve({result: 'no notes to migrate'});
    });
}

/**
 * Attach note to issueIid
 * @param {int} issueIid
 * @param {object} noteData
 * @return {Promise<unknown | void>|Promise<Awaited<{dryRun: string, issue, action: string}>>}
 */
function addNote(issueIid, noteData)
{
    let url = gitlabAPIURLBase + '/projects/' + gitLab.project.id + '/issues/' + issueIid + '/notes';
    if (dryRun) {
        verbose ? log_verbose('DryRun: Add note to issue ' + issueIid + '; send POST-request to ' + url) : null;
        verbose ? log_verbose(noteData) : null;
        return Promise.resolve({'dryRun': 'yes', 'action': 'POST', 'issue': issueIid});
    }

    // Set Sudo to author-user for request if available
    let Sudo = gitlabSudo;
    if (noteData.hasOwnProperty('author')) {
        Sudo = noteData.author;
    }

    return superagent
        .post(url)
        .set({'PRIVATE-TOKEN': gitlabAdminPrivateToken, 'Sudo': Sudo, accept: 'json'})
        .send(noteData)
        .then((result) => {
            verbose ? log_verbose('Inserted note to issue '+ issueIid + '/' + result.body.id) : null;
            return result.body;
        })
        .catch((error) => {
                if (error) {
                    if (verbose && error.response) {
                        console.error(error.response);
                    }
                    throw new Error('Failed to insert note to issue into GitLab: ' + url);
                }
            }
        );
}


function log_progress(message) {
    if (dryRun) message = 'DRYRUN: ' + message;
    console.log(message.brightGreen);
}

function log_verbose(message) {
    if ('string' == typeof message || 'number' == typeof message) {
        if (dryRun) message = 'DRYRUN: ' + message;
        message = message.green;
    }
    console.log(message);
}