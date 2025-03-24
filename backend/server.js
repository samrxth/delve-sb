const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

// Enhanced logger
const logger = {
  log: (message) => {
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`);
  },
  warn: (message) => {
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`);
  },
  error: (message, error = null) => {
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`);
    if (error) {
      console.error(error);
    }
  }
};

// Setup evidence directory
const EVIDENCE_DIR = path.join(__dirname, 'evidence');

// Ensure evidence directory exists
const ensureEvidenceDir = async () => {
  try {
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });
    logger.log(`Evidence directory ensured at ${EVIDENCE_DIR}`);
  } catch (error) {
    logger.error(`Failed to create evidence directory: ${error.message}`, error);
  }
};

// Initialize
ensureEvidenceDir();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Evidence logs storage (in-memory and file-based)
let evidenceLogs = [];

// Log evidence with enhanced detail and file storage
const logEvidence = async (action, status, details, projectRef = null) => {
  const timestamp = new Date().toISOString();
  
  // Create structured log entry
  const log = {
    id: `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    timestamp,
    action,
    status,
    details,
    projectRef
  };
  
  // Add to in-memory storage
  evidenceLogs.push(log);
  
  // Log to console
  logger.log(`Evidence logged: ${action} - ${status}`);
  
  // Save to file system
  try {
    // Create project-specific directory if provided
    if (projectRef) {
      const projectDir = path.join(EVIDENCE_DIR, projectRef);
      await fs.mkdir(projectDir, { recursive: true });
      
      // Save to project-specific log
      const projectLogPath = path.join(projectDir, `${action}_${timestamp.replace(/:/g, '-')}.json`);
      await fs.writeFile(projectLogPath, JSON.stringify(log, null, 2));
    }
    
    // Save to main evidence log
    const mainLogPath = path.join(EVIDENCE_DIR, 'evidence_log.json');
    let mainLog = [];
    
    try {
      const existingLog = await fs.readFile(mainLogPath, 'utf8');
      mainLog = JSON.parse(existingLog);
    } catch (readError) {
      // File doesn't exist yet or is corrupted, start with empty array
      logger.warn(`No existing evidence log found or error reading it: ${readError.message}`);
    }
    
    mainLog.push(log);
    await fs.writeFile(mainLogPath, JSON.stringify(mainLog, null, 2));
    
    return log.id;
  } catch (error) {
    logger.error(`Failed to save evidence log: ${error.message}`, error);
    return null;
  }
};

// Get project logs from in-memory storage
const getProjectLogs = (projectRef) => evidenceLogs.filter(log => log.projectRef === projectRef);

// Get project logs from file system
const getProjectLogsFromFiles = async (projectRef) => {
  try {
    const projectDir = path.join(EVIDENCE_DIR, projectRef);
    
    try {
      await fs.access(projectDir);
    } catch {
      // Directory doesn't exist, return empty array
      return [];
    }
    
    const files = await fs.readdir(projectDir);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    const logs = await Promise.all(jsonFiles.map(async (file) => {
      const content = await fs.readFile(path.join(projectDir, file), 'utf8');
      return JSON.parse(content);
    }));
    
    return logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  } catch (error) {
    logger.error(`Failed to retrieve project logs from files: ${error.message}`, error);
    return [];
  }
};

// Token middleware with detailed logging
const validateToken = (req, res, next) => {
  // Check multiple sources for token
  const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.substring(7) : 
               req.headers['supabase-token'] || 
               req.body?.token || 
               req.query?.token;
  
  if (!token) {
    logEvidence('token_validation', 'failure', { 
      message: 'Missing token',
      endpoint: req.originalUrl,
      method: req.method,
      ip: req.ip,
      headers: req.headers
    });
    
    return res.status(401).json({ error: 'Supabase token is required' });
  }
  
  // Log token validation attempt (mask the actual token)
  logEvidence('token_validation_attempt', 'info', {
    endpoint: req.originalUrl,
    method: req.method,
    ip: req.ip,
    tokenProvided: true,
    tokenSource: req.headers.authorization ? 'Authorization header' :
                 req.headers['supabase-token'] ? 'supabase-token header' :
                 req.body?.token ? 'request body' : 'query parameter'
  });
  
  req.token = token;
  next();
};

// Execute SQL query with detailed logging
const executeQuery = async (projectRef, token, query, queryName = 'unnamed_query') => {
  try {
    // Log query execution attempt
    const queryLogId = await logEvidence('sql_query_attempt', 'info', {
      projectRef,
      queryName,
      query: query.length > 1000 ? `${query.substring(0, 1000)}...` : query,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    const response = await axios.post(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      { query },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Handle different response formats
    let results = [];
    if (response.data && Array.isArray(response.data)) {
      results = response.data.length > 0 && Array.isArray(response.data[0]) ? 
                response.data[0] : 
                response.data;
    }
    
    // Log successful query
    await logEvidence('sql_query_success', 'success', {
      projectRef,
      queryName,
      query: query.length > 1000 ? `${query.substring(0, 1000)}...` : query,
      resultCount: results.length,
      queryLogId,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    return results;
  } catch (error) {
    // Log query failure with detailed error
    await logEvidence('sql_query_failure', 'error', {
      projectRef,
      queryName,
      query: query.length > 1000 ? `${query.substring(0, 1000)}...` : query,
      error: error.message,
      errorCode: error.response?.status,
      errorDetails: error.response?.data,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    logger.error(`SQL execution error for ${queryName}: ${error.message}`, error);
    throw error;
  }
};

// -------------- API ROUTES --------------

// Health check endpoint
app.get('/health', (req, res) => {
  logEvidence('health_check', 'info', {
    ip: req.ip,
    timestamp: new Date().toISOString()
  });
  
  res.status(200).json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Token validation endpoint
app.post('/api/auth/validate', async (req, res) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      await logEvidence('token_validation', 'failure', { 
        message: 'Token is required',
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
      
      return res.status(400).json({ error: 'Token is required' });
    }
    
    try {
      // Log validation attempt
      const validationAttemptId = await logEvidence('token_validation_attempt', 'info', {
        ip: req.ip,
        timestamp: new Date().toISOString()
      });
      
      const response = await axios.get('https://api.supabase.com/v1/projects', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Extract project information
      const projects = response.data;
      
      // Log successful validation with project details
      await logEvidence('token_validation', 'success', { 
        message: 'Token validated successfully',
        validationAttemptId,
        projectCount: projects.length,
        projectRefs: projects.map(p => p.ref),
        timestamp: new Date().toISOString()
      });
      
      return res.status(200).json({ 
        valid: true, 
        projects: projects,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      // Log validation failure with error details
      await logEvidence('token_validation', 'failure', { 
        message: 'Invalid token',
        error: error.message,
        errorStatus: error.response?.status,
        errorDetails: error.response?.data,
        timestamp: new Date().toISOString()
      });
      
      return res.status(401).json({ 
        error: 'Invalid Supabase token',
        details: error.message,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Validation error', error.message);
    
    await logEvidence('server_error', 'error', {
      endpoint: '/api/auth/validate',
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    return res.status(500).json({ 
      error: 'Server error',
      timestamp: new Date().toISOString()
    });
  }
});

// Get all projects
app.get('/api/projects', validateToken, async (req, res) => {
  try {
    const { token } = req;
    
    // Log project list request
    const requestId = await logEvidence('projects_request', 'info', {
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    
    const response = await axios.get('https://api.supabase.com/v1/projects', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    
    // Log successful project retrieval
    await logEvidence('projects_retrieved', 'success', {
      requestId,
      projectCount: response.data.length,
      projectRefs: response.data.map(p => p.ref),
      timestamp: new Date().toISOString()
    });
    
    res.status(200).json({
      projects: response.data,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching projects', error.message);
    
    // Log project retrieval failure
    await logEvidence('projects_retrieval_failure', 'error', {
      error: error.message,
      errorStatus: error.response?.status,
      errorDetails: error.response?.data,
      timestamp: new Date().toISOString()
    });
    
    res.status(500).json({ 
      error: 'Failed to fetch projects',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Run compliance check (comprehensive endpoint)
app.get('/api/compliance/check/:projectRef', validateToken, async (req, res) => {
  try {
    const { projectRef } = req.params;
    const { token } = req;
    
    logger.log(`Starting compliance check for project: ${projectRef}`);
    
    // Log compliance check initiation
    const checkId = await logEvidence('compliance_check_initiated', 'info', {
      projectRef,
      ip: req.ip,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    // Run checks in parallel for efficiency
    const [mfaResult, rlsResult, pitrResult] = await Promise.all([
      // MFA check
      (async () => {
        try {
          // Log MFA check start
          const mfaCheckId = await logEvidence('mfa_check_started', 'info', {
            projectRef,
            parentCheckId: checkId,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Get auth config
          const authConfigUrl = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
          const settingsResponse = await axios.get(authConfigUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });
          
          const authConfig = settingsResponse.data;
          
          // Determine MFA status
          const mfaEnabled = authConfig && (
            (authConfig.sms_provider && authConfig.sms_provider !== 'NONE') || 
            authConfig.mfa_enabled || 
            authConfig.external_mfa_enabled
          );
          
          // Log auth config retrieved
          await logEvidence('auth_config_retrieved', 'info', {
            projectRef,
            mfaCheckId,
            config: {
              ...authConfig,
              // Mask any sensitive fields that might be present
              sms_provider_auth_token: authConfig.sms_provider_auth_token ? '[REDACTED]' : undefined,
              smtp_pass: authConfig.smtp_pass ? '[REDACTED]' : undefined,
              secure_email_change_token: authConfig.secure_email_change_token ? '[REDACTED]' : undefined
            },
            mfaEnabled,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Get users using SQL query
          const query = `
            SELECT 
              id, 
              email, 
              (
                SELECT count(*) > 0 
                FROM auth.mfa_factors 
                WHERE user_id = u.id
              ) as has_mfa
            FROM auth.users u;
          `;
          
          let users = [];
          try {
            const result = await executeQuery(projectRef, token, query, 'mfa_user_query');
            
            users = result.map(user => ({
              id: user.id,
              email: user.email,
              hasMFA: user.has_mfa,
              status: user.has_mfa ? 'pass' : 'fail'
            }));
            
            // Log user MFA status
            await logEvidence('user_mfa_status', 'info', {
              projectRef,
              mfaCheckId,
              userCount: users.length,
              usersWithMfa: users.filter(u => u.hasMFA).length,
              usersWithoutMfa: users.filter(u => !u.hasMFA).length,
              timestamp: new Date().toISOString()
            }, projectRef);
          } catch (userError) {
            logger.warn('Error fetching users with SQL:', userError.message);
            
            // Log MFA user query failure
            await logEvidence('mfa_user_query_failure', 'warning', {
              projectRef,
              mfaCheckId,
              error: userError.message,
              timestamp: new Date().toISOString()
            }, projectRef);
          }
          
          // Prepare summary
          const summary = {
            total: users.length,
            passing: users.filter(u => u.status === 'pass').length,
            failing: users.filter(u => u.status === 'fail').length
          };
          
          // Log MFA check completion
          await logEvidence('mfa_check_completed', 'info', {
            projectRef,
            mfaCheckId,
            mfaEnabledGlobally: mfaEnabled,
            summary,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          return {
            mfaEnabledGlobally: mfaEnabled,
            users,
            summary,
            checkId: mfaCheckId
          };
        } catch (err) {
          logger.error('Error in MFA check:', err.message);
          
          // Log MFA check failure
          await logEvidence('mfa_check_failed', 'error', {
            projectRef,
            parentCheckId: checkId,
            error: err.message,
            errorDetails: err.response?.data,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          return {
            error: err.message,
            summary: { total: 0, passing: 0, failing: 0 }
          };
        }
      })(),
      
      // RLS check
      (async () => {
        try {
          // Log RLS check start
          const rlsCheckId = await logEvidence('rls_check_started', 'info', {
            projectRef,
            parentCheckId: checkId,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // SQL query to check RLS status
          const query = `
            SELECT 
              n.nspname AS schemaname, 
              c.relname AS tablename, 
              pg_get_userbyid(c.relowner) AS tableowner,
              (SELECT EXISTS (
                SELECT 1 FROM pg_policies 
                WHERE schemaname = n.nspname AND tablename = c.relname
              )) AS has_policies,
              c.relrowsecurity AS rls_enabled
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'r'
            AND n.nspname = 'public'
            AND c.relname NOT LIKE 'pg_%'
            AND c.relname NOT LIKE 'sql_%'
            ORDER BY n.nspname, c.relname;
          `;
          
          const tables = await executeQuery(projectRef, token, query, 'rls_tables_query');
          
          // Map results to a more friendly format
          const publicTables = tables.map(table => ({
            id: `${table.schemaname}.${table.tablename}`,
            name: table.tablename,
            schema: table.schemaname,
            rlsEnabled: table.rls_enabled,
            hasPolicies: table.has_policies,
            status: table.rls_enabled ? 'pass' : 'fail'
          }));
          
          // Log table RLS status
          await logEvidence('table_rls_status', 'info', {
            projectRef,
            rlsCheckId,
            tableCount: publicTables.length,
            tablesWithRls: publicTables.filter(t => t.rlsEnabled).length,
            tablesWithoutRls: publicTables.filter(t => !t.rlsEnabled).length,
            tablesWithPolicies: publicTables.filter(t => t.hasPolicies).length,
            tablesWithoutPolicies: publicTables.filter(t => !t.hasPolicies).length,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Prepare summary
          const summary = {
            total: publicTables.length,
            passing: publicTables.filter(t => t.status === 'pass').length,
            failing: publicTables.filter(t => t.status === 'fail').length
          };
          
          // Log RLS check completion
          await logEvidence('rls_check_completed', 'info', {
            projectRef,
            rlsCheckId,
            summary,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          return {
            tables: publicTables,
            summary,
            checkId: rlsCheckId
          };
        } catch (err) {
          logger.error('Error in RLS check:', err.message);
          
          // Log RLS check failure
          await logEvidence('rls_check_failed', 'error', {
            projectRef,
            parentCheckId: checkId,
            error: err.message,
            errorDetails: err.response?.data,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          return {
            error: err.message,
            summary: { total: 0, passing: 0, failing: 0 }
          };
        }
      })(),
      
      // PITR check
      (async () => {
        try {
          // Log PITR check start
          const pitrCheckId = await logEvidence('pitr_check_started', 'info', {
            projectRef,
            parentCheckId: checkId,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Get backup configuration
          const backupsUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/backups`;
          
          const backupsResponse = await axios.get(backupsUrl, {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });
          
          const backupsConfig = backupsResponse.data || {};
          const pitrEnabled = backupsConfig.pitr_enabled === true;
          
          // Log PITR configuration retrieved
          await logEvidence('pitr_config_retrieved', 'info', {
            projectRef,
            pitrCheckId,
            config: backupsConfig,
            pitrEnabled,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Log PITR check completion
          await logEvidence('pitr_check_completed', 'info', {
            projectRef,
            pitrCheckId,
            pitrEnabled,
            status: pitrEnabled ? 'pass' : 'fail',
            timestamp: new Date().toISOString()
          }, projectRef);
          
          return {
            pitrEnabled,
            status: pitrEnabled ? 'pass' : 'fail',
            backupsConfig,
            checkId: pitrCheckId
          };
        } catch (err) {
          logger.error('Error in PITR check:', err.message);
          
          // Log PITR check failure
          await logEvidence('pitr_check_failed', 'error', {
            projectRef,
            parentCheckId: checkId,
            error: err.message,
            errorDetails: err.response?.data,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          return {
            error: err.message,
            pitrEnabled: false,
            status: 'error',
            checkId: null
          };
        }
      })()
    ]);
    
    // Compile overall result
    const result = {
      projectRef,
      timestamp: new Date().toISOString(),
      checkId,
      mfa: mfaResult,
      rls: rlsResult,
      pitr: pitrResult,
      summary: {
        mfa: mfaResult.summary || { total: 0, passing: 0, failing: 0 },
        rls: rlsResult.summary || { total: 0, passing: 0, failing: 0 },
        pitr: {
          passing: pitrResult.status === 'pass' ? 1 : 0,
          failing: pitrResult.status === 'fail' ? 1 : 0,
          total: pitrResult.status === 'error' ? 0 : 1
        },
        overallStatus: 
          (mfaResult.summary?.failing === 0 && 
           rlsResult.summary?.failing === 0 && 
           pitrResult.status === 'pass') ? 'pass' : 'fail'
      }
    };
    
    // Log overall compliance check completion
    await logEvidence('compliance_check_completed', 'success', {
      projectRef,
      checkId,
      summary: result.summary,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error running compliance checks:', error.message);
    
    // Log compliance check failure
    await logEvidence('compliance_check_failed', 'error', {
      projectRef: req.params.projectRef,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }, req.params.projectRef);
    
    res.status(500).json({ 
      error: 'Failed to run compliance checks', 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Fix compliance issues (comprehensive endpoint)
app.post('/api/compliance/fix/:projectRef', validateToken, async (req, res) => {
  try {
    const { projectRef } = req.params;
    const { token } = req;
    const { fixMfa = true, fixRls = true, fixPitr = true } = req.body;
    
    logger.log(`Starting compliance fixes for project: ${projectRef}`);
    
    // Log fix initiation
    const fixId = await logEvidence('compliance_fix_initiated', 'info', {
      projectRef,
      fixOptions: { fixMfa, fixRls, fixPitr },
      ip: req.ip,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    // Step 1: Check current compliance status
    const complianceStatus = await (async () => {
      try {
        // Log compliance status check
        const statusCheckId = await logEvidence('compliance_status_check', 'info', {
          projectRef,
          parentFixId: fixId,
          timestamp: new Date().toISOString()
        }, projectRef);
        
        // MFA status
        const mfaStatus = await (async () => {
          try {
            const authConfigUrl = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
            const settingsResponse = await axios.get(authConfigUrl, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            });
            
            const authConfig = settingsResponse.data;
            const mfaNeedsFix = !authConfig || !(
              (authConfig.sms_provider && authConfig.sms_provider !== 'NONE') || 
              authConfig.mfa_enabled || 
              authConfig.external_mfa_enabled
            );
            
            // Log MFA status
            await logEvidence('mfa_status_checked', 'info', {
              projectRef,
              statusCheckId,
              mfaNeedsFix,
              mfaEnabled: !mfaNeedsFix,
              timestamp: new Date().toISOString()
            }, projectRef);
            
            return { needsFix: mfaNeedsFix };
          } catch (err) {
            logger.error('Error checking MFA status:', err.message);
            
            // Log MFA status check failure
            await logEvidence('mfa_status_check_failed', 'error', {
              projectRef,
              statusCheckId,
              error: err.message,
              errorDetails: err.response?.data,
              timestamp: new Date().toISOString()
            }, projectRef);
            
            return { needsFix: false, error: err.message };
          }
        })();
        
        // RLS status - find tables needing RLS
        const rlsStatus = await (async () => {
          try {
            const query = `
              SELECT 
                n.nspname AS schemaname, 
                c.relname AS tablename
              FROM pg_catalog.pg_class c
              JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind = 'r'
              AND n.nspname = 'public'
              AND c.relname NOT LIKE 'pg_%'
              AND c.relname NOT LIKE 'sql_%'
              AND NOT c.relrowsecurity
              ORDER BY n.nspname, c.relname;
            `;
            
            const tables = await executeQuery(projectRef, token, query, 'rls_missing_tables_query');
            
            // Log RLS tables status
            await logEvidence('rls_tables_checked', 'info', {
              projectRef,
              statusCheckId,
              tablesNeedingRls: tables.length,
              tables: tables.map(t => `${t.schemaname}.${t.tablename}`),
              timestamp: new Date().toISOString()
            }, projectRef);
            
            return {
              needsFix: tables.length > 0,
              tables: tables.map(t => ({ schema: t.schemaname, name: t.tablename }))
            };
          } catch (err) {
            logger.error('Error checking RLS status:', err.message);
            
            // Log RLS status check failure
            await logEvidence('rls_status_check_failed', 'error', {
              projectRef,
              statusCheckId,
              error: err.message,
              errorDetails: err.response?.data,
              timestamp: new Date().toISOString()
            }, projectRef);
            
            return { needsFix: false, tables: [], error: err.message };
          }
        })();
        
        // PITR status
        const pitrStatus = await (async () => {
          try {
            const backupsUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/backups`;
            const backupsResponse = await axios.get(backupsUrl, {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            });
            
            const backupsConfig = backupsResponse.data || {};
            const pitrNeedsFix = !backupsConfig.pitr_enabled;
            
            // Log PITR status
            await logEvidence('pitr_status_checked', 'info', {
              projectRef,
              statusCheckId,
              pitrNeedsFix,
              pitrEnabled: !pitrNeedsFix,
              timestamp: new Date().toISOString()
            }, projectRef);
            
            return { needsFix: pitrNeedsFix };
          } catch (err) {
            logger.error('Error checking PITR status:', err.message);
            
            // Log PITR status check failure
            await logEvidence('pitr_status_check_failed', 'error', {
              projectRef,
              statusCheckId,
              error: err.message,
              errorDetails: err.response?.data,
              timestamp: new Date().toISOString()
            }, projectRef);
            
            return { needsFix: false, error: err.message };
          }
        })();
        
        // Log completed status check
        await logEvidence('compliance_status_check_completed', 'info', {
          projectRef,
          statusCheckId,
          mfaStatus,
          rlsStatus,
          pitrStatus,
          timestamp: new Date().toISOString()
        }, projectRef);
        
        return {
          mfa: mfaStatus,
          rls: rlsStatus,
          pitr: pitrStatus
        };
      } catch (error) {
        logger.error('Error checking compliance status:', error.message);
        
        // Log status check failure
        await logEvidence('compliance_status_check_failed', 'error', {
          projectRef,
          parentFixId: fixId,
          error: error.message,
          stack: error.stack,
          timestamp: new Date().toISOString()
        }, projectRef);
        
        throw error;
      }
    })();
    
    // Step 2: Apply fixes
    const fixes = {
      mfa: { 
        needed: complianceStatus.mfa.needsFix && fixMfa,
        applied: false,
        success: false,
        error: null 
      },
      rls: { 
        needed: complianceStatus.rls.needsFix && fixRls,
        tableCount: complianceStatus.rls.tables.length,
        applied: false,
        success: false,
        tables: [],
        error: null 
      },
      pitr: { 
        needed: complianceStatus.pitr.needsFix && fixPitr,
        applied: false,
        success: false,
        error: null 
      }
    };
    
    // Log fix plan
    await logEvidence('compliance_fix_plan', 'info', {
      projectRef,
      fixId,
      fixes,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    // Fix MFA if needed
    if (fixes.mfa.needed) {
      try {
        // Log MFA fix attempt
        const mfaFixId = await logEvidence('mfa_fix_attempt', 'info', {
          projectRef,
          parentFixId: fixId,
          timestamp: new Date().toISOString()
        }, projectRef);
        
        const authConfigUrl = `https://api.supabase.com/v1/projects/${projectRef}/config/auth`;
        
        // Log MFA config update details
        await logEvidence('mfa_config_update', 'info', {
          projectRef,
          mfaFixId,
          updatePayload: { 
            mfa_enabled: true,
            mfa_required: true 
          },
          timestamp: new Date().toISOString()
        }, projectRef);
        
        const response = await axios.patch(authConfigUrl,
          { 
            mfa_enabled: true,
            mfa_required: true 
          },
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );
        
        fixes.mfa.applied = true;
        fixes.mfa.success = true;
        
        // Log MFA fix success
        await logEvidence('mfa_fix_success', 'success', { 
          projectRef,
          mfaFixId,
          response: response.data,
          timestamp: new Date().toISOString()
        }, projectRef);
      } catch (error) {
        fixes.mfa.applied = true;
        fixes.mfa.error = error.message;
        
        // Log MFA fix failure
        await logEvidence('mfa_fix_failure', 'error', { 
          projectRef,
          error: error.message,
          errorStatus: error.response?.status,
          errorDetails: error.response?.data,
          timestamp: new Date().toISOString()
        }, projectRef);
      }
    }
    
    // Fix RLS if needed
    if (fixes.rls.needed) {
      fixes.rls.applied = true;
      
      // Log RLS fix attempt
      const rlsFixId = await logEvidence('rls_fix_attempt', 'info', {
        projectRef,
        parentFixId: fixId,
        tableCount: complianceStatus.rls.tables.length,
        tables: complianceStatus.rls.tables.map(t => `${t.schema}.${t.name}`),
        timestamp: new Date().toISOString()
      }, projectRef);
      
      try {
        // Use a single SQL transaction to enable RLS on all tables
        let query = 'BEGIN;\n';
        complianceStatus.rls.tables.forEach(table => {
          // Use quoted identifiers to handle tables with special characters
          query += `ALTER TABLE "${table.schema}"."${table.name}" ENABLE ROW LEVEL SECURITY;\n`;
        });
        query += 'COMMIT;';
        
        // Log RLS batch transaction
        await logEvidence('rls_batch_transaction', 'info', {
          projectRef,
          rlsFixId,
          query: query.length > 1000 ? `${query.substring(0, 1000)}...` : query,
          timestamp: new Date().toISOString()
        }, projectRef);
        
        await executeQuery(projectRef, token, query, 'rls_batch_enable');
        
        fixes.rls.success = true;
        fixes.rls.tables = complianceStatus.rls.tables.map(table => ({
          table: `${table.schema}.${table.name}`,
          success: true
        }));
        
        // Log RLS fix success
        await logEvidence('rls_fix_success', 'success', { 
          projectRef,
          rlsFixId,
          tableCount: complianceStatus.rls.tables.length,
          timestamp: new Date().toISOString()
        }, projectRef);
      } catch (error) {
        fixes.rls.success = false;
        fixes.rls.error = error.message;
        
        // Log RLS batch fix failure
        await logEvidence('rls_batch_fix_failure', 'error', {
          projectRef,
          rlsFixId,
          error: error.message,
          errorStatus: error.response?.status,
          errorDetails: error.response?.data,
          timestamp: new Date().toISOString()
        }, projectRef);
        
        // Fall back to individual table fixes if batch fails
        try {
          // Log RLS individual fix fallback
          await logEvidence('rls_individual_fix_fallback', 'info', {
            projectRef,
            rlsFixId,
            tableCount: complianceStatus.rls.tables.length,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          const rlsPromises = complianceStatus.rls.tables.map(async (table) => {
            try {
              // Use quoted identifiers
              const query = `ALTER TABLE "${table.schema}"."${table.name}" ENABLE ROW LEVEL SECURITY;`;
              
              // Log individual table fix attempt
              const tableFixId = await logEvidence('rls_table_fix_attempt', 'info', {
                projectRef,
                rlsFixId,
                table: `${table.schema}.${table.name}`,
                query,
                timestamp: new Date().toISOString()
              }, projectRef);
              
              await executeQuery(projectRef, token, query, `rls_enable_${table.schema}_${table.name}`);
              
              // Log individual table fix success
              await logEvidence('rls_table_fix_success', 'success', {
                projectRef,
                tableFixId,
                table: `${table.schema}.${table.name}`,
                timestamp: new Date().toISOString()
              }, projectRef);
              
              return { table: `${table.schema}.${table.name}`, success: true };
            } catch (tableError) {
              // Log individual table fix failure
              await logEvidence('rls_table_fix_failure', 'error', {
                projectRef,
                table: `${table.schema}.${table.name}`,
                error: tableError.message,
                errorStatus: tableError.response?.status,
                errorDetails: tableError.response?.data,
                timestamp: new Date().toISOString()
              }, projectRef);
              
              return { 
                table: `${table.schema}.${table.name}`, 
                success: false, 
                error: tableError.message 
              };
            }
          });
          
          fixes.rls.tables = await Promise.all(rlsPromises);
          fixes.rls.success = fixes.rls.tables.every(t => t.success);
          
          // Log RLS individual fixes summary
          await logEvidence('rls_individual_fixes_completed', 
            fixes.rls.success ? 'success' : 'partial_success', 
            { 
              projectRef, 
              rlsFixId,
              tableCount: fixes.rls.tables.length,
              successCount: fixes.rls.tables.filter(t => t.success).length,
              failureCount: fixes.rls.tables.filter(t => !t.success).length,
              timestamp: new Date().toISOString()
            }, 
            projectRef
          );
        } catch (fallbackError) {
          fixes.rls.error = `Batch error: ${error.message}. Fallback error: ${fallbackError.message}`;
          
          // Log RLS fallback failure
          await logEvidence('rls_fallback_failure', 'error', { 
            projectRef,
            rlsFixId,
            error: fixes.rls.error,
            timestamp: new Date().toISOString()
          }, projectRef);
        }
      }
    }
    
    // Fix PITR if needed
    if (fixes.pitr.needed) {
      // Log PITR fix attempt
      const pitrFixId = await logEvidence('pitr_fix_attempt', 'info', {
        projectRef,
        parentFixId: fixId,
        timestamp: new Date().toISOString()
      }, projectRef);
      
      try {
        // Try using SQL to enable PITR first
        const pitrSqlQuery = "SELECT pg_create_physical_replication_slot('pitr_slot');";
        
        try {
          // Log SQL approach attempt
          await logEvidence('pitr_sql_fix_attempt', 'info', {
            projectRef,
            pitrFixId,
            query: pitrSqlQuery,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          await executeQuery(projectRef, token, pitrSqlQuery, 'pitr_enable_sql');
          fixes.pitr.applied = true;
          fixes.pitr.success = true;
          
          // Log SQL approach success
          await logEvidence('pitr_sql_fix_success', 'success', {
            projectRef,
            pitrFixId,
            timestamp: new Date().toISOString()
          }, projectRef);
        } catch (sqlError) {
          logger.warn('SQL approach to enable PITR failed, trying API:', sqlError.message);
          
          // Log SQL approach failure
          await logEvidence('pitr_sql_fix_failure', 'warning', {
            projectRef,
            pitrFixId,
            error: sqlError.message,
            errorDetails: sqlError.response?.data,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Log API approach attempt
          await logEvidence('pitr_api_fix_attempt', 'info', {
            projectRef,
            pitrFixId,
            timestamp: new Date().toISOString()
          }, projectRef);
          
          // Fall back to API method
          const backupsUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/backups`;
          const response = await axios.patch(backupsUrl,
            { pitr_enabled: true },
            {
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            }
          );
          
          fixes.pitr.applied = true;
          fixes.pitr.success = true;
          
          // Log API approach success
          await logEvidence('pitr_api_fix_success', 'success', {
            projectRef,
            pitrFixId,
            response: response.data,
            timestamp: new Date().toISOString()
          }, projectRef);
        }
      } catch (error) {
        fixes.pitr.applied = true;
        fixes.pitr.error = error.message;
        
        // Log PITR fix failure
        await logEvidence('pitr_fix_failure', 'error', {
          projectRef,
          error: error.message,
          errorStatus: error.response?.status,
          errorDetails: error.response?.data,
          timestamp: new Date().toISOString()
        }, projectRef);
      }
    }
    
    // Step 3: Prepare result
    const result = {
      projectRef,
      timestamp: new Date().toISOString(),
      fixId,
      summary: {
        mfa: !fixes.mfa.needed ? 'no_action_needed' : 
             (fixes.mfa.success ? 'fixed' : 'failed'),
        rls: !fixes.rls.needed ? 'no_action_needed' : 
             (fixes.rls.success ? 'fixed' : 
              (fixes.rls.tables.some(t => t.success) ? 'partially_fixed' : 'failed')),
        pitr: !fixes.pitr.needed ? 'no_action_needed' : 
              (fixes.pitr.success ? 'fixed' : 'failed')
      },
      details: fixes
    };
    
    // Overall success status
    const allSuccessful = 
      (!fixes.mfa.needed || fixes.mfa.success) && 
      (!fixes.rls.needed || fixes.rls.success) && 
      (!fixes.pitr.needed || fixes.pitr.success);
    
    // Log fix completion
    await logEvidence('compliance_fix_completed', allSuccessful ? 'success' : 'partial_success', {
      projectRef,
      fixId,
      summary: result.summary,
      allSuccessful,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    res.status(200).json(result);
  } catch (error) {
    logger.error('Error in compliance fix:', error.message);
    
    // Log fix failure
    await logEvidence('compliance_fix_failure', 'error', {
      projectRef: req.params.projectRef,
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    }, req.params.projectRef);
    
    res.status(500).json({ 
      error: 'Failed to fix compliance issues', 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get evidence logs
app.get('/api/evidence/logs/:projectRef?', validateToken, async (req, res) => {
  try {
    const { projectRef } = req.params;
    
    // Log evidence request
    await logEvidence('evidence_logs_request', 'info', {
      projectRef: projectRef || 'all',
      ip: req.ip,
      timestamp: new Date().toISOString()
    }, projectRef);
    
    // Get logs from file system for more persistence
    const logs = projectRef 
      ? await getProjectLogsFromFiles(projectRef) 
      : evidenceLogs;
    
    res.status(200).json({
      logs,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching evidence logs:', error.message);
    
    await logEvidence('evidence_logs_request_failure', 'error', {
      projectRef: req.params.projectRef || 'all',
      error: error.message,
      timestamp: new Date().toISOString()
    }, req.params.projectRef);
    
    res.status(500).json({ 
      error: 'Failed to fetch evidence logs',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Start the server
app.listen(PORT, () => {
  logger.log(`Server running on port ${PORT}`);
  
  // Log server start
  logEvidence('server_start', 'info', {
    port: PORT,
    timestamp: new Date().toISOString()
  });
});

module.exports = app;
