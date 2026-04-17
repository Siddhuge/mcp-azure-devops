# MCP Azure DevOps - Pipeline Failure Analyzer

A **Model Context Protocol (MCP) Server** that analyzes Azure DevOps pipeline failures and provides intelligent root cause analysis with actionable fix suggestions.

## 🎯 Overview

This project connects to Azure DevOps, retrieves build logs, and uses a sophisticated **rule engine** to classify pipeline failures. It helps teams quickly identify what went wrong in their CI/CD pipelines and get recommendations on how to fix them.

### Key Features
- **Real-time Pipeline Analysis**: Fetch and analyze logs from Azure DevOps builds
- **Intelligent Failure Classification**: Rule-based detection of common failure patterns
- **Actionable Fix Suggestions**: Get specific recommendations based on failure type
- **High Performance**: Retry logic and efficient log filtering
- **Secure**: PAT-based authentication with Azure DevOps
- **Production-Ready**: Error handling, rate limiting, and request ID tracking

## 📋 What It Does

### 1. **Log Retrieval**
Connects to Azure DevOps API to fetch build logs for a specific build ID.

### 2. **Log Parsing & Filtering**
Extracts error messages, warnings, and failures from raw logs:
- Filters lines containing: `error`, `failed`, `exception`, `warning`, `toomanyrequests`

### 3. **Rule Engine Classification**
Matches filtered logs against predefined rules to identify failure types:
- **DOCKER_RATE_LIMIT**: Docker Hub rate limit exceeded
- **DOCKER_FAILURE**: Docker build or pull failures
- **BUILD_FAILURE**: Compilation/build errors
- **CONFIG_DEPRECATED**: Deprecated configuration warnings
- *And more...*

### 4. **Failure Analysis**
Returns structured failure analysis:
```json
{
  "failureType": "INFRA_DOCKER_RATE_LIMIT",
  "rootCause": "You have reached your unauthenticated pull rate limit",
  "fix": "Authenticate Docker (docker login) or use private registry",
  "severity": "HIGH",
  "confidence": 0.95,
  "source": "RULE_ENGINE"
}
```

## 🏗️ Project Structure

```
src/
├── app.js                    # Express app setup
├── server.js               # Server entry point
├── config/
│   ├── env.js             # Environment validation with Joi
│   └── logger.js          # Pino logger configuration
├── controllers/
│   └── logs.controller.js # Request handlers
├── middleware/
│   ├── auth.js            # Authentication middleware
│   ├── errorHandler.js    # Global error handler
│   ├── rateLimiter.js     # Rate limiting
│   └── requestId.js       # Request ID tracking
├── routes/
│   └── logs.route.js      # API routes
├── services/
│   ├── azure.service.js   # Azure DevOps API integration
│   └── classifier.service.js # Failure classification logic
├── schemas/
│   └── logs.schema.js     # Joi validation schemas
└── utils/
    ├── asyncHandler.js    # Async error wrapper
    ├── errors.js          # Custom error classes
    ├── logParser.js       # Log parsing utility
    └── ruleEngine.js      # Failure detection rules
```

## 🚀 Getting Started

### Prerequisites
- Node.js 14+
- Azure DevOps Organization & Project
- Azure Personal Access Token (PAT)

### Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd mcp-azure-devops
```

2. **Install dependencies**
```bash
npm install
```

3. **Configure environment variables**
Create a `.env` file in the root directory:
```env
PORT=4000
AZURE_ORG=your-organization
AZURE_PROJECT=your-project
AZURE_PAT=your-personal-access-token
```

**How to get Azure PAT:**
1. Go to https://dev.azure.com
2. User Settings → Personal access tokens → New Token
3. Select scopes: `Build (read)`, `Code (read)`

4. **Start the server**
```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## 📡 API Endpoints

### Get Build Logs Metadata
```
GET /logs/:buildId
```
Returns metadata for all logs in a build.

### Get Raw Log Content
```
GET /logs/:buildId/:logId
```
Returns raw log file content.

### Analyze & Classify Failure
```
GET /logs/:buildId/classify
```
Analyzes the build and returns failure classification with fix suggestions.

**Example:**
```bash
curl http://localhost:4000/logs/99/classify
```

**Response:**
```json
{
  "failureType": "INFRA_DOCKER_RATE_LIMIT",
  "rootCause": "You have reached your unauthenticated pull rate limit",
  "fix": "Authenticate Docker (docker login) or use private registry",
  "severity": "HIGH",
  "confidence": 0.95,
  "source": "RULE_ENGINE",
  "totalLines": 1088,
  "filteredLines": 59
}
```

### Health Check
```
GET /health
```
Returns server health status.

## 🔧 Configuration

### Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 4000) |
| `AZURE_ORG` | **Yes** | Azure DevOps organization name |
| `AZURE_PROJECT` | **Yes** | Azure DevOps project name |
| `AZURE_PAT` | **Yes** | Personal Access Token for authentication |

### Rule Engine Rules
Customize failure detection in [`src/utils/ruleEngine.js`](src/utils/ruleEngine.js):

```javascript
{
  name: "RULE_NAME",
  pattern: /regex-pattern/i,
  failureType: "FAILURE_TYPE",
  severity: "HIGH|MEDIUM|LOW",
  priority: 100,  // Higher = checked first
  fix: "Suggested fix"
}
```

## 🔐 Security Features

- **Rate Limiting**: Prevents abuse with express-rate-limit
- **Helmet.js**: Sets security HTTP headers
- **CORS**: Configured for localhost (port 3000)
- **PAT Authentication**: Secure Azure DevOps authentication
- **Request ID Tracking**: Unique ID per request for tracing
- **Environment Validation**: Joi schema validation on startup

## 📊 Middleware Stack

- **helmet**: HTTP header security
- **cors**: Cross-Origin Resource Sharing
- **express.json**: JSON parsing
- **requestId**: Request ID middleware
- **pinoHttp**: HTTP request logging
- **rateLimiter**: Rate limiting
- **errorHandler**: Centralized error handling

## 🛠️ Development

### Available Scripts

```bash
npm start    # Start production server
npm run dev  # Start with nodemon (auto-reload)
```

### Testing the Classifier

1. Get a build ID from your Azure DevOps project
2. Test the endpoint:
```bash
curl http://localhost:4000/logs/99/classify | python3 -m json.tool
```

### Adding New Rules
1. Open [`src/utils/ruleEngine.js`](src/utils/ruleEngine.js)
2. Add a new rule object to the `rules` array
3. Restart the server

## 📚 Dependencies

- **express**: Web framework
- **axios**: HTTP client for Azure API
- **joi**: Schema validation
- **pino**: Logging
- **helmet**: Security headers
- **cors**: CORS handling
- **express-rate-limit**: Rate limiting
- **dotenv**: Environment variable loading

## 🐛 Error Handling

The application includes comprehensive error handling:

- **400**: Bad Request (missing buildId)
- **401**: Authentication errors (invalid PAT)
- **404**: Build or log not found
- **429**: Rate limit exceeded
- **500**: Server error with request ID for tracing

All errors are logged with unique request IDs for debugging.

## 🎯 Common Failure Types

| Type | Cause | Fix |
|------|-------|-----|
| `INFRA_DOCKER_RATE_LIMIT` | Docker Hub pull limit | Authenticate or use private registry |
| `INFRA_DOCKER_FAILURE` | Docker build/pull failed | Check Docker logs |
| `BUILD_FAILURE` | Compilation error | Fix code errors |
| `CONFIG_DEPRECATED` | Deprecated settings | Update configuration |

## 📖 MCP (Model Context Protocol)

This server implements the Model Context Protocol, enabling AI models and tools to:
- Query pipeline status
- Analyze build failures
- Suggest fixes automatically
- Integrate with CI/CD workflows

Tool definition: [`.mcp/tools/azureLogs.json`](.mcp/tools/azureLogs.json)

## 🚨 Troubleshooting

### Error: "buildId required"
Ensure you're passing the buildId in the URL: `/logs/99/classify`

### Error: "Azure returned HTML → auth issue"
- Verify `AZURE_PAT` is correct in `.env`
- Check PAT has `Build (read)` scope
- Verify `AZURE_ORG` and `AZURE_PROJECT` names

### 429 Too Many Requests
The server has rate limiting enabled. Wait before retrying.

### Logs show "FALLBACK" source
No matching rules found. Add new rule pattern to catch this error type.

## 📝 License

MIT

## 👤 Author

Built as an MCP server for Azure DevOps pipeline analysis and debugging.

## 📬 Support

For issues and feature requests, please check the project repository.
