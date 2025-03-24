'use client';

import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { GoogleGenerativeAI } from "@google/generative-ai";

// Simple markdown to HTML converter
const parseMarkdown = (text) => {
  if (!text) return '';
  
  return text
    // Handle headings
    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
    
    // Handle bold
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    
    // Handle italic
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    
    // Handle lists (unordered)
    .replace(/^\s*-\s+(.*$)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n)+/g, (match) => `<ul>${match}</ul>`)
    
    // Handle code blocks
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    
    // Handle inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    
    // Handle paragraphs
    .replace(/^(?!<[a-z]|\s*$)(.*$)/gm, '<p>$1</p>');
};

export default function Home() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [complianceData, setComplianceData] = useState(null);
  const [showChat, setShowChat] = useState(false);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [apiUrl, setApiUrl] = useState('https://delve-sb.onrender.com/');
  const [geminiKey, setGeminiKey] = useState('');
  const [showResults, setShowResults] = useState(true);
  const [showTokenSection, setShowTokenSection] = useState(true);
  const [showProjectsSection, setShowProjectsSection] = useState(true);
  const messagesEndRef = useRef(null);

  // Debug logging helper
  const logDebug = (message, data) => {
    console.log(`[DEBUG] ${message}`, data);
  };

    // Add styles for markdown elements
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      h1, h2, h3, h4, h5, h6 {
        margin: 5px 0;
        font-weight: bold;
      }
      h1 { font-size: 1.3em; }
      h2 { font-size: 1.2em; }
      ul, ol {
        margin: 5px 0;
        padding-left: 20px;
      }
      li {
        margin: 2px 0;
      }
      p {
        margin: 5px 0;
      }
      code {
        background-color: #f0f0f0;
        padding: 2px 4px;
        font-family: monospace;
        border-radius: 3px;
      }
      pre {
        background-color: #f0f0f0;
        padding: 8px;
        margin: 5px 0;
        border-radius: 3px;
        overflow-x: auto;
      }
    `;
    document.head.appendChild(style);
    
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  // Scroll to bottom of chat
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // Clear chat when project changes
  useEffect(() => {
    setMessages([]);
    // Also clear the messagesEndRef when project changes
    if (messagesEndRef.current) {
      messagesEndRef.current = null;
    }
  }, [selectedProject]);

  // Hide token and projects section when project is selected
  useEffect(() => {
    if (selectedProject) {
      setShowTokenSection(false);
      setShowProjectsSection(false);
    }
  }, [selectedProject]);

  // Fetch projects
  const fetchProjects = async () => {
    if (!token) return;
    setLoading(true);
    try {
      logDebug("Validating token", token.substring(0, 5) + "...");
      const response = await axios.post(`${apiUrl}/api/auth/validate`, { token });
      logDebug("Token validation response", response.data);
      
      if (response.data.valid && response.data.projects) {
        setProjects(response.data.projects);
      }
    } catch (error) {
      console.error("Error validating token:", error);
      alert('Invalid token or server error');
    } finally {
      setLoading(false);
    }
  };

  // Get project ID/reference field from a project object
  const getProjectRef = (project) => {
    // Try different possible field names for project reference
    return project.ref || project.id || project.reference || project.project_ref || project.projectRef;
  };

  // Check compliance
  const checkCompliance = async (project) => {
    setLoading(true);
    
    // Extract project reference from project object or use it directly if it's a string
    const projectRef = typeof project === 'object' ? getProjectRef(project) : project;
    
    logDebug("Checking compliance for project", { projectRef, project });
    
    if (!projectRef) {
      console.error("Project reference is undefined", project);
      alert("Could not determine project reference");
      setLoading(false);
      return;
    }
    
    try {
      const response = await axios.get(
        `${apiUrl}/api/compliance/check/${projectRef}`,
        { params: { token } }
      );
      logDebug("Compliance check response", response.data);
      setComplianceData(response.data);
      setSelectedProject(projectRef);
    } catch (error) {
      console.error('Error checking compliance:', error);
      alert('Error checking compliance: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  // Fix compliance
  const fixCompliance = async () => {
    if (!selectedProject) {
      alert("No project selected");
      return;
    }
    
    setLoading(true);
    logDebug("Fixing compliance for project", selectedProject);
    
    try {
      const response = await axios.post(
        `${apiUrl}/api/compliance/fix/${selectedProject}`,
        {},
        { params: { token } }
      );
      logDebug("Fix compliance response", response.data);
      alert('Fixed. Refreshing...');
      await checkCompliance(selectedProject);
    } catch (error) {
      console.error('Error fixing compliance:', error);
      alert('Error fixing compliance: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  // Chat with AI
  const sendMessage = async () => {
    if (!newMessage.trim() || !complianceData) return;

    const userMessage = newMessage.trim();
    setMessages([...messages, { role: 'user', text: userMessage }]);
    setNewMessage('');
    
    try {
      // Use user-provided Gemini API key
      const GEMINI_API_KEY = geminiKey || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
      
      if (!GEMINI_API_KEY) {
        setMessages(prev => [...prev, { 
          role: 'ai', 
          text: "Please enter a Gemini API key in the field above the chat to enable AI assistance." 
        }]);
        return;
      }

      // Create detailed context from compliance data
      const context = `
      Project ${selectedProject} compliance details:
      
      Multi-Factor Authentication (MFA):
      - MFA globally enabled: ${complianceData.mfa.mfaEnabledGlobally ? 'Yes' : 'No'}
      - Users with MFA enabled: ${complianceData.summary.mfa.passing}/${complianceData.summary.mfa.total}
      
      Row-Level Security (RLS):
      - Tables with RLS enabled: ${complianceData.summary.rls.passing}/${complianceData.summary.rls.total}
      
      Point-in-Time Recovery (PITR):
      - PITR status: ${complianceData.pitr.pitrEnabled ? 'Enabled' : 'Disabled'}
      
      ${complianceData.rls.tables.filter(t => !t.rlsEnabled).length > 0 
        ? `Tables without RLS: ${complianceData.rls.tables.filter(t => !t.rlsEnabled).map(t => t.name).join(', ')}` 
        : ''}
      
      ${complianceData.mfa.users && complianceData.mfa.users.filter(u => !u.hasMFA).length > 0 
        ? `Users without MFA: ${complianceData.mfa.users.filter(u => !u.hasMFA).map(u => u.email).join(', ')}` 
        : ''}
      `;

      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
      
      const instructions = `
        You are a Supabase security compliance assistant. Help developers understand and fix security issues in their Supabase projects. 
        Focus on explaining what the compliance issues mean and how to fix them.
        Keep responses concise and actionable. Use bullet points for suggestions.
        
        When advising about:
        - Multi-Factor Authentication (MFA): Explain its importance for account security and preventing unauthorized access
        - Row-Level Security (RLS): Explain why it's critical for data protection and how it prevents unauthorized access to data
        - Point-in-Time Recovery (PITR): Explain its value for disaster recovery and data protection, including backup strategies
        
        When providing fixes, always maintain a focus on security best practices. Be brief but thorough.
        Format your response using proper Markdown for clear formatting:
        - Use **bold text** for emphasis
        - Use bullet points with - for lists
        - Use ## for section headings
        
        FOCUS ON HOW TO FIX THEM
        State what must be done differently if in a paid or free account
      `;
      
      const prompt = `${context}\n\nUser question: ${userMessage}`;
      
      const result = await model.generateContent([instructions, prompt]);
      const aiResponse = result.response.text();
      
      setMessages(prev => [...prev, { role: 'ai', text: aiResponse }]);
    } catch (error) {
      console.error('Error getting AI response:', error);
      setMessages(prev => [...prev, { 
        role: 'ai', 
        text: 'Error processing request. Please try again or check your Gemini API key.' 
      }]);
    }
  };

  // Reset to initial state
  const resetView = () => {
    setSelectedProject(null);
    setComplianceData(null);
    setShowTokenSection(true);
    setShowProjectsSection(true);
    setShowChat(false);
    setShowResults(true);
    setMessages([]);
  };

  const styles = {
    container: {
      fontFamily: 'Space Mono, monospace',
      maxWidth: '1200px', 
      margin: '0 auto',
      padding: selectedProject ? '20px' : '30px', 
      color: '#222',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    mainContent: {
      overflowY: 'auto',
      flex: 1,
      padding: '0',
      marginBottom: '0',
    },
    title: {
      fontSize: '22px',
      fontWeight: '700',
      marginBottom: selectedProject ? '10px' : '15px',
      borderBottom: '1px solid #ddd',
      paddingBottom: selectedProject ? '5px' : '10px',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    backLink: {
      fontSize: '14px',
      textDecoration: 'underline',
      cursor: 'pointer',
    },
    inputGroup: {
      marginBottom: '20px',
      maxWidth: '600px', 
    },
    input: {
      width: '100%',
      padding: '10px',
      border: '1px solid #ddd',
      borderRadius: '0',
      fontFamily: 'Space Mono, monospace',
      marginBottom: '10px',
      fontSize: '14px',
    },
    button: {
      backgroundColor: 'white',
      color: 'black',
      border: '1px solid black',
      padding: '10px 20px',
      cursor: 'pointer',
      fontFamily: 'Space Mono, monospace',
      borderRadius: '0',
      fontSize: '14px',
      transition: 'background-color 0.2s',
    },
    buttonAction: {
      backgroundColor: 'black',
      color: 'white',
      border: '1px solid black',
    },
    projectList: {
      listStyle: 'none',
      padding: '0',
      margin: '20px 0',
      maxWidth: '800px', 
    },
    projectItem: {
      padding: '10px',
      marginBottom: '10px',
      border: '1px solid #eee',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    projectText: {
      fontWeight: '500',
    },
    section: {
      margin: selectedProject ? '5px 0' : '15px 0',
    },
    sectionHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: selectedProject ? '8px' : '15px',
      borderBottom: '1px solid #eee',
      paddingBottom: selectedProject ? '4px' : '8px',
    },
    sectionTitle: {
      fontSize: '18px',
      fontWeight: '700',
    },
    toggleButton: {
      border: 'none',
      background: 'none',
      cursor: 'pointer',
      fontSize: '12px',
      textDecoration: 'underline',
    },
    complianceList: {
      listStyle: 'none',
      padding: '0',
    },
    complianceItem: {
      padding: selectedProject ? '5px 0' : '10px 0',
      borderBottom: '1px solid #f5f5f5',
    },
    statusPass: {
      color: '#2E7D32',
      fontWeight: '700',
    },
    statusFail: {
      color: '#C62828',
      fontWeight: '700',
    },
    subList: {
      listStyle: 'none',
      padding: '5px 0 5px 20px',
      margin: '5px 0',
      borderLeft: '2px solid #eee',
    },
    subItem: {
      padding: '5px 0',
      fontSize: '14px',
    },
    chatContainer: {
      border: '1px solid #eee',
      padding: '5px',
      marginTop: '5px',
      marginBottom: '0',
      display: 'flex',
      flexDirection: 'column',
      height: selectedProject ? 'calc(100vh - 160px)' : '500px', // Adjusted height to account for text entry
    },
    chatHeader: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: '8px',
    },
    keyInput: {
      width: '100%', 
      padding: '6px',
      border: '1px solid #ddd',
      borderRadius: '0',
      marginBottom: '10px',
      fontFamily: 'Space Mono, monospace',
      fontSize: '14px',
    },
    chatMessages: {
      overflowY: 'auto',
      flex: 1,
      marginBottom: '5px',
      padding: '5px',
      backgroundColor: '#f9f9f9',
    },
    userMessage: {
      backgroundColor: '#f0f0f0',
      padding: '8px',
      marginBottom: '8px',
      borderRadius: '0',
    },
    aiMessage: {
      backgroundColor: '#e0e0e0',
      padding: '8px',
      marginBottom: '8px',
      borderRadius: '0',
    },
    chatInput: {
      display: 'flex',
      gap: '10px',
    },
    chatTextInput: {
      flex: '1',
      padding: '10px',
      border: '1px solid #ddd',
      borderRadius: '0',
      fontFamily: 'Space Mono, monospace',
    },
    chatSendButton: {
      backgroundColor: 'black',
      color: 'white',
      border: 'none',
      padding: '10px 20px',
      cursor: 'pointer',
      borderRadius: '0',
    },
    actionButtons: {
      display: 'flex',
      gap: '10px',
      marginTop: '10px',
      marginBottom: '0',
    },
  };

  return (
    <div style={styles.container}>
      <div style={styles.mainContent}>
        <div style={styles.title}>
          <h1>Supabase Compliance Checker</h1>
          {selectedProject && (
            <span style={styles.backLink} onClick={resetView}>← Back to Projects</span>
          )}
        </div>
        
        {/* Token Input */}
        {showTokenSection && (
          <div style={styles.inputGroup}>
            <input
              style={styles.input}
              type="text"
              placeholder="Supabase Management Token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button 
              style={{...styles.button, ...(loading ? {} : styles.buttonAction)}}
              onClick={fetchProjects}
              disabled={loading || !token}
            >
              {loading ? 'Loading...' : 'Validate Token'}
            </button>
          </div>
        )}
        
        {/* Project Selection */}
        {showProjectsSection && projects.length > 0 && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Projects</h2>
            </div>
            <ul style={styles.projectList}>
              {projects.map((project, index) => {
                const projectRef = getProjectRef(project);
                const isInactive = project.status === "INACTIVE";
                return (
                  <li key={projectRef || index} style={styles.projectItem}>
                    <span style={{
                      ...styles.projectText,
                      color: isInactive ? '#C62828' : 'inherit'
                    }}>
                      {project.name || `Project ${index + 1}`}
                      {isInactive && ' (Inactive)'}
                    </span>
                    <button 
                      style={{
                        ...styles.button, 
                        ...(loading ? {} : isInactive ? { 
                          backgroundColor: '#e0e0e0', 
                          color: '#888',
                          borderColor: '#ccc',
                          cursor: 'not-allowed'
                        } : styles.buttonAction)
                      }}
                      onClick={() => checkCompliance(project)}
                      disabled={!projectRef || loading || isInactive}
                    >
                      {isInactive ? 'Project Inactive' : 'Check Compliance'}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        
        {/* Compliance Results */}
        {complianceData && (
          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <h2 style={styles.sectionTitle}>Compliance Results</h2>
              <button 
                style={styles.toggleButton}
                onClick={() => setShowResults(!showResults)}
              >
                {showResults ? 'Hide Details' : 'Show Details'}
              </button>
            </div>
            
            {showResults && (
              <>
                <ul style={styles.complianceList}>
                  {/* MFA */}
                  <li style={styles.complianceItem}>
                    <strong>Multi-Factor Authentication (MFA):</strong>{' '}
                    <span 
                      style={complianceData.mfa.mfaEnabledGlobally ? styles.statusPass : styles.statusFail}
                    >
                      {complianceData.mfa.mfaEnabledGlobally ? 'Globally Enabled' : 'Globally Disabled'}
                    </span>
                    <div>Users with MFA: {complianceData.summary.mfa.passing}/{complianceData.summary.mfa.total}</div>
                    
                    {complianceData.mfa.users && complianceData.mfa.users.filter(u => !u.hasMFA).length > 0 && (
                      <ul style={styles.subList}>
                        {complianceData.mfa.users.filter(u => !u.hasMFA).map((user, index) => (
                          <li key={user.id || index} style={styles.subItem}>
                            {user.email} <span style={styles.statusFail}>• No MFA</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                  
                  {/* RLS */}
                  <li style={styles.complianceItem}>
                    <strong>Row-Level Security (RLS):</strong>{' '}
                    <div>Tables with RLS: {complianceData.summary.rls.passing}/{complianceData.summary.rls.total}</div>
                    
                    {complianceData.rls.tables && complianceData.rls.tables.filter(t => !t.rlsEnabled).length > 0 && (
                      <ul style={styles.subList}>
                        {complianceData.rls.tables.filter(t => !t.rlsEnabled).map((table, index) => (
                          <li key={table.id || index} style={styles.subItem}>
                            {table.name} <span style={styles.statusFail}>• No RLS</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                  
                  {/* PITR */}
                  <li style={styles.complianceItem}>
                    <strong>Point-in-Time Recovery (PITR):</strong>{' '}
                    <span 
                      style={complianceData.pitr.pitrEnabled ? styles.statusPass : styles.statusFail}
                    >
                      {complianceData.pitr.pitrEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </li>
                </ul>
                
                {/* Actions */}
                <div style={styles.actionButtons}>
                  
                  <button 
                    style={{...styles.button}}
                    onClick={() => {
                      setShowChat(!showChat);
                      if (!showChat) {
                        // When opening chat, hide results
                        setShowResults(false);
                      } else {
                        // When closing chat, show results
                        setShowResults(true);
                      }
                    }}
                  >
                    {showChat ? 'Hide Assistant' : 'Security Assistant'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        
        {/* Chat Section */}
        {showChat && complianceData && (
          <div style={styles.chatContainer}>
            <div style={styles.chatHeader}>
              <h2 style={styles.sectionTitle}>Security Assistant</h2>
              <button 
                style={styles.toggleButton}
                onClick={() => {
                  setShowChat(false);
                  setShowResults(true);
                }}
              >
                Close Assistant
              </button>
            </div>
            
            <input
              style={styles.keyInput}
              type="text"
              placeholder="Enter your Gemini API key here"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
            />
            
            <div style={styles.chatMessages}>
              {messages.length === 0 ? (
                <p>Ask about security compliance and best practices</p>
              ) : (
                messages.map((msg, index) => (
                  <div 
                    key={index} 
                    style={msg.role === 'user' ? styles.userMessage : styles.aiMessage}
                  >
                    <strong>{msg.role === 'user' ? 'You:' : 'Assistant:'}</strong> 
                    <span dangerouslySetInnerHTML={{ __html: parseMarkdown(msg.text) }} />
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
            
            <div style={styles.chatInput}>
              <input
                style={styles.chatTextInput}
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Ask a security question..."
              />
              <button 
                style={{...styles.button, ...styles.buttonAction}}
                onClick={sendMessage}
                disabled={!newMessage.trim()}
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
